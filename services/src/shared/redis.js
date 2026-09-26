// Redis client + the Lua scripts. A Lua script runs inside Redis as one uninterrupted step, so
// "check the fencing token, then write" can never be split by another client's write.
import IORedis from 'ioredis';
import { config } from './config.js';
import { logger } from './logger.js';

export const keys = {
  gameState: (g) => `game:${g}:state`, // hash: the checkpoint a new leader resumes from
  gameConfig: (g) => `game:${g}:config`, // JSON: questions, timings
  fence: (g) => `game:${g}:fence`, // highest fencing token seen for this game
  seq: (g) => `game:${g}:seq`, // message sequence number
  log: (g) => `game:${g}:log`, // stream of recent room messages (for resume)
  channel: (g) => `room:${g}`, // pub/sub channel the gateways subscribe to
  answers: (g) => `game:${g}:answers`, // stream: the answer burst
  answered: (g, q) => `game:${g}:q:${q}:answers`, // hash user -> "choice|recvAt" (first answer wins)
  dist: (g, q) => `game:${g}:q:${q}:dist`, // hash choice -> count
  points: (g, q) => `game:${g}:q:${q}:points`, // hash user -> points for that question
  leaderboard: (g) => `game:${g}:lb`, // sorted set user -> score
  correct: (g) => `game:${g}:correct`, // hash user -> number of correct answers
  players: (g) => `game:${g}:players`, // set of players (joined before the start)
  alive: (g) => `game:${g}:alive`, // set of players still "in the game"
  names: (g) => `game:${g}:names`, // hash user -> display name
  wsTicket: (t) => `wsticket:${t}`,
  bucket: (k) => `rl:${k}`,
  instance: (svc, id) => `ops:${svc}:${id}`,
};

const SCRIPTS = {
  // Token bucket (from Project 1): capacity, refill per second. Returns {allowed, remaining, retryAfterMs}.
  tokenBucket: {
    numberOfKeys: 1,
    lua: `
      local t = redis.call('TIME')
      local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
      local cap = tonumber(ARGV[1]); local rate = tonumber(ARGV[2])
      local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
      local tokens = tonumber(b[1]) or cap; local ts = tonumber(b[2]) or now
      tokens = math.min(cap, tokens + (now - ts) / 1000 * rate)
      local allowed = 0
      if tokens >= 1 then tokens = tokens - 1; allowed = 1 end
      redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
      redis.call('PEXPIRE', KEYS[1], math.ceil(cap / rate * 1000) + 1000)
      local retry = 0
      if allowed == 0 then retry = math.ceil((1 - tokens) / rate * 1000) end
      return {allowed, math.floor(tokens), retry}`,
  },

  // A new leader raises the fence to its token. Returns the fence value after the call.
  // If the fence is already higher, this leader is out of date and must step down.
  claimFence: {
    numberOfKeys: 1,
    lua: `
      local fence = tonumber(redis.call('GET', KEYS[1]) or '0')
      local token = tonumber(ARGV[1])
      if token > fence then redis.call('SET', KEYS[1], token); return token end
      return fence`,
  },

  // Publish one room message + save the checkpoint, but ONLY if the caller's token is not older
  // than the fence. Assigns the sequence number, appends to the resume log, publishes, saves state.
  // KEYS: fence, seq, state, log   ARGV: token, channel, message JSON (must start with {"seq":0,), maxlen, field, value, ...
  fencedPublish: {
    numberOfKeys: 4,
    lua: `
      local fence = tonumber(redis.call('GET', KEYS[1]) or '0')
      local token = tonumber(ARGV[1])
      if token < fence then return {-1, fence} end
      if token > fence then redis.call('SET', KEYS[1], token) end
      local seq = redis.call('INCR', KEYS[2])
      local msg = '{"seq":' .. seq .. string.sub(ARGV[3], 9)
      redis.call('XADD', KEYS[4], 'MAXLEN', '~', ARGV[4], seq .. '-0', 'm', msg)
      if #ARGV > 4 then
        local args = {}
        for i = 5, #ARGV do args[#args + 1] = ARGV[i] end
        redis.call('HSET', KEYS[3], unpack(args))
      end
      redis.call('HSET', KEYS[3], 'seq', seq)
      redis.call('PUBLISH', ARGV[2], msg)
      return {seq, token}`,
  },

  // A message that may be dropped (live answer count), or no message at all: just the leader's
  // heartbeat time in the checkpoint. No sequence number, no log. Still fenced.
  // KEYS: fence, state   ARGV: token, channel, message ('' = none), nowMs
  fencedEphemeral: {
    numberOfKeys: 2,
    lua: `
      local fence = tonumber(redis.call('GET', KEYS[1]) or '0')
      if tonumber(ARGV[1]) < fence then return -1 end
      redis.call('HSET', KEYS[2], 'beat', ARGV[4])
      if ARGV[3] ~= '' then redis.call('PUBLISH', ARGV[2], ARGV[3]) end
      return 1`,
  },

  // Score a batch of players for one question. Idempotent: a player is scored only once per
  // question (HSETNX), so a new leader can safely redo scoring after a crash.
  // KEYS: fence, points(q), leaderboard, alive, correctCounts   ARGV: token, user, points, eliminate(0/1), ...
  fencedScore: {
    numberOfKeys: 5,
    lua: `
      local fence = tonumber(redis.call('GET', KEYS[1]) or '0')
      if tonumber(ARGV[1]) < fence then return -1 end
      local n = 0
      for i = 2, #ARGV, 3 do
        if redis.call('HSETNX', KEYS[2], ARGV[i], ARGV[i + 1]) == 1 then
          local p = tonumber(ARGV[i + 1])
          if p > 0 then
            redis.call('ZINCRBY', KEYS[3], p, ARGV[i])
            redis.call('HINCRBY', KEYS[5], ARGV[i], 1)
          end
          if ARGV[i + 2] == '1' then redis.call('SREM', KEYS[4], ARGV[i]) end
          n = n + 1
        end
      end
      return n`,
  },

  // Record answers: first answer per player per question wins; count the distribution.
  // Only players who joined before the start can answer (spectators cannot).
  // KEYS: answered(q), dist(q), players   ARGV: user, choice, recvAt, ...   Returns 1 (new) / 0 (duplicate) / 2 (not a player).
  recordAnswers: {
    numberOfKeys: 3,
    lua: `
      local out = {}
      for i = 1, #ARGV, 3 do
        if redis.call('SISMEMBER', KEYS[3], ARGV[i]) == 0 then
          out[#out + 1] = 2
        elseif redis.call('HSETNX', KEYS[1], ARGV[i], ARGV[i + 1] .. '|' .. ARGV[i + 2]) == 1 then
          redis.call('HINCRBY', KEYS[2], ARGV[i + 1], 1)
          out[#out + 1] = 1
        else
          out[#out + 1] = 0
        end
      end
      return out`,
  },
};

export function createRedis(name = 'main', opts = {}) {
  const client = new IORedis(config.redisUrl, {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
    connectionName: `${config.instanceId}:${name}`,
    retryStrategy: (times) => Math.min(times * 200, 2000),
    ...opts,
  });
  for (const [cmd, def] of Object.entries(SCRIPTS)) client.defineCommand(cmd, { numberOfKeys: def.numberOfKeys, lua: def.lua });
  let warned = false;
  client.on('error', (err) => {
    if (!warned) logger.warn({ err: err.message, name }, 'redis connection problem');
    warned = true;
  });
  client.on('ready', () => {
    if (warned) logger.info({ name }, 'redis reconnected');
    warned = false;
  });
  return client;
}

export const redis = createRedis('main');

/** Token bucket helper. Fails open if Redis is unavailable (same choice as Projects 1-4). */
export async function takeToken(bucketKey, capacity, perSec) {
  try {
    const [allowed, remaining, retryMs] = await redis.tokenBucket(keys.bucket(bucketKey), capacity, perSec);
    return { allowed: allowed === 1, remaining, retryAfterSec: Math.ceil(retryMs / 1000) };
  } catch {
    return { allowed: true, remaining: -1, retryAfterSec: 0, failedOpen: true };
  }
}
