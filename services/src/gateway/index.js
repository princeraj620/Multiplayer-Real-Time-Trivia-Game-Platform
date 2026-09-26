// WebSocket gateway: holds player connections.
//
// A gateway knows WHO is connected, not how the game works. It subscribes to one Redis pub/sub
// channel per room that has local players, and copies every room message to those sockets. Answers
// go the other way, into a Redis Stream that the room's leader engine reads.
//
// Any gateway can serve any player, and a player whose gateway dies reconnects to another one and
// continues from the last message they saw (resume by sequence number).
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { redis, keys, createRedis } from '../shared/redis.js';
import { counter, gauge, histogram, metricsHandler } from '../shared/metrics.js';
import { startOpsReporter } from '../shared/ops.js';
import { tracer, SpanKind, context, trace, currentTraceparent } from '../shared/tracing.js';

const mConnects = counter('buzz_ws_connects_total', 'WebSocket connection attempts', ['result']);
const mSent = counter('buzz_ws_messages_sent_total', 'Messages sent to sockets', ['type']);
const mFanout = histogram('buzz_ws_fanout_seconds', 'From the engine publishing a message to this gateway finishing sending it to every local player', ['type'], [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2]);
const mAnswers = counter('buzz_ws_answers_total', 'Answers received from players', ['result']);
const mSlow = counter('buzz_ws_slow_consumer_total', 'Slow sockets: messages dropped or sockets closed', ['action']);
const mResume = counter('buzz_ws_resumes_total', 'Joins that resumed from a sequence number', ['result']);
const mReplayed = counter('buzz_ws_replayed_messages_total', 'Messages replayed to reconnecting players');

const DROPPABLE = new Set(['tally', 'presence']);

class Bucket {
  constructor(capacity, perSec) {
    this.cap = capacity;
    this.rate = perSec;
    this.tokens = capacity;
    this.ts = Date.now();
  }
  take() {
    const now = Date.now();
    this.tokens = Math.min(this.cap, this.tokens + ((now - this.ts) / 1000) * this.rate);
    this.ts = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

export async function start() {
  const sub = createRedis('pubsub');
  const pub = createRedis('answers', { enableAutoPipelining: true });
  const rooms = new Map(); // gameId -> { clients:Set, state:{}, lastAt }
  const clients = new Set();
  const counters = { answers: 0, sent: 0, fanoutMs: [] };

  gauge('buzz_ws_connections', 'Open WebSocket connections', [], function collect() {
    this.set(clients.size);
  });
  gauge('buzz_ws_rooms', 'Rooms with at least one local player', [], function collect() {
    this.set(rooms.size);
  });

  // ---------- sending ----------

  function send(c, raw, type) {
    const ws = c.ws;
    if (ws.readyState !== 1) return false;
    if (ws.bufferedAmount > config.slowSocketCloseBytes) {
      mSlow.labels('closed').inc();
      ws.terminate();
      return false;
    }
    if (DROPPABLE.has(type) && ws.bufferedAmount > config.slowSocketDropBytes) {
      mSlow.labels('dropped').inc();
      return false;
    }
    ws.send(raw);
    mSent.labels(type).inc();
    counters.sent++;
    return true;
  }
  const sendJson = (c, obj) => send(c, JSON.stringify(obj), obj.type);

  // ---------- rooms ----------

  async function getRoom(gameId) {
    let room = rooms.get(gameId);
    if (room) return room;
    room = { clients: new Set(), state: {}, ready: null };
    rooms.set(gameId, room);
    room.ready = (async () => {
      await sub.subscribe(keys.channel(gameId));
      room.state = normaliseState(await redis.hgetall(keys.gameState(gameId)));
    })();
    await room.ready;
    return room;
  }

  function normaliseState(s) {
    return { phase: s.phase || 'LOBBY', q: Number(s.q || 0), openedAt: Number(s.openedAt || 0), deadline: Number(s.deadline || 0), seq: Number(s.seq || 0), leader: s.leader, token: Number(s.token || 0) };
  }

  function leaveRoom(c) {
    const room = rooms.get(c.gameId);
    if (!room) return;
    room.clients.delete(c);
    if (room.clients.size === 0) {
      rooms.delete(c.gameId);
      sub.unsubscribe(keys.channel(c.gameId)).catch(() => {});
    }
    c.gameId = null;
  }

  // A message from a room's leader engine.
  sub.on('message', (channel, raw) => {
    const gameId = channel.slice(5);
    const room = rooms.get(gameId);
    if (!room) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.seq && msg.seq > room.state.seq) applyToState(room.state, msg);
    for (const c of room.clients) {
      if (c.joining) {
        c.buffer.push([msg, raw]);
        continue;
      }
      if (msg.seq && msg.seq <= c.seq) continue;
      if (send(c, raw, msg.type) && msg.seq) c.seq = msg.seq;
    }
    if (msg.at) {
      const secs = Math.max(0, (Date.now() - msg.at) / 1000);
      mFanout.labels(msg.type).observe(secs);
      if (msg.type === 'question') {
        counters.fanoutMs.push(secs * 1000);
        if (counters.fanoutMs.length > 50) counters.fanoutMs.shift();
      }
    }
    if (msg.type === 'reveal' || msg.type === 'finished') sendPersonalResults(gameId, room, msg).catch((err) => logger.warn({ err: err.message }, 'personal results failed'));
  });

  function applyToState(st, msg) {
    st.seq = msg.seq;
    if (msg.leader) {
      st.leader = msg.leader;
      st.token = msg.token;
    }
    switch (msg.type) {
      case 'countdown':
        st.phase = 'COUNTDOWN';
        break;
      case 'question':
        Object.assign(st, { phase: 'QUESTION', q: msg.q, openedAt: msg.openedAt, deadline: msg.deadline });
        break;
      case 'locked':
        st.phase = 'LOCKED';
        break;
      case 'reveal':
        st.phase = 'REVEAL';
        break;
      case 'leaderboard':
        st.phase = 'LEADERBOARD';
        break;
      case 'finished':
        st.phase = 'FINISHED';
        break;
      default:
    }
  }

  // After the reveal, each gateway tells ITS players their own result. The rank lookups are
  // pipelined in batches of 500, so 17,000 players cost ~35 round trips, not 17,000.
  async function sendPersonalResults(gameId, room, msg) {
    const q = msg.q ?? room.state.q;
    const list = [...room.clients].filter((c) => !c.spectator);
    for (let i = 0; i < list.length; i += 500) {
      const chunk = list.slice(i, i + 500);
      const p = redis.pipeline();
      for (const c of chunk) {
        if (msg.type === 'reveal') {
          p.hget(keys.points(gameId, q), c.user.id);
          p.hget(keys.answered(gameId, q), c.user.id);
        } else {
          p.echo('');
          p.echo('');
        }
        p.zscore(keys.leaderboard(gameId), c.user.id);
        p.zrevrank(keys.leaderboard(gameId), c.user.id);
        p.sismember(keys.alive(gameId), c.user.id);
      }
      const res = await p.exec();
      chunk.forEach((c, j) => {
        const [points, answered, score, rank, alive] = res.slice(j * 5, j * 5 + 5).map((r) => r[1]);
        const choice = answered ? Number(String(answered).split('|')[0]) : null;
        sendJson(c, {
          type: 'you',
          after: msg.type,
          q,
          choice,
          points: points === null || points === '' ? null : Number(points),
          correct: msg.type === 'reveal' ? choice === msg.correct : undefined,
          score: Number(score || 0),
          rank: rank === null ? null : Number(rank) + 1,
          alive: alive === 1,
        });
      });
    }
  }

  // ---------- joining and resuming ----------

  async function join(c, gameId, lastSeq) {
    if (c.gameId && c.gameId !== gameId) leaveRoom(c);
    const cfgRaw = await redis.get(keys.gameConfig(gameId));
    if (!cfgRaw) return sendJson(c, { type: 'error', code: 'NO_SUCH_GAME', message: 'This game does not exist or has ended' });
    const cfg = JSON.parse(cfgRaw);
    c.joining = true;
    c.buffer = [];
    c.gameId = gameId;
    c.seq = 0;
    const room = await getRoom(gameId);
    room.clients.add(c);

    const st = normaliseState(await redis.hgetall(keys.gameState(gameId)));
    const uid = c.user.id;
    const isPlayer = await redis.sismember(keys.players(gameId), uid);
    const isHost = cfg.hostId === uid;
    if (!isPlayer && st.phase === 'LOBBY' && !isHost && c.user.role !== 'admin') {
      await redis.multi().sadd(keys.players(gameId), uid).sadd(keys.alive(gameId), uid).zadd(keys.leaderboard(gameId), 'NX', 0, uid).hset(keys.names(gameId), uid, c.user.name).exec();
      c.spectator = false;
    } else {
      c.spectator = !isPlayer;
    }

    // Replay: from lastSeq+1 if the log still has it, otherwise from the start of the current question.
    let entries = [];
    let resumed = false;
    if (lastSeq > 0) {
      entries = await redis.xrange(keys.log(gameId), `${lastSeq + 1}-0`, '+');
      const first = entries[0] ? Number(entries[0][0].split('-')[0]) : null;
      if (first === lastSeq + 1 || (entries.length === 0 && st.seq === lastSeq)) {
        resumed = true;
        mResume.labels('from_seq').inc();
      } else {
        mResume.labels('gap_snapshot').inc();
        entries = [];
      }
    }
    if (!resumed) {
      const recent = await redis.xrevrange(keys.log(gameId), '+', '-', 'COUNT', 60);
      const out = [];
      for (const e of recent) {
        out.unshift(e);
        const t = JSON.parse(e[1][1]).type;
        if (t === 'question' || t === 'countdown' || t === 'finished') break;
      }
      entries = out;
    }

    const [score, rank, alive, players, answered] = await Promise.all([
      redis.zscore(keys.leaderboard(gameId), uid),
      redis.zrevrank(keys.leaderboard(gameId), uid),
      redis.sismember(keys.alive(gameId), uid),
      redis.scard(keys.players(gameId)),
      st.phase === 'QUESTION' || st.phase === 'LOCKED' ? redis.hget(keys.answered(gameId, st.q), uid) : null,
    ]);
    if (answered) c.answered.set(st.q, Number(answered.split('|')[0]));
    sendJson(c, {
      type: 'joined',
      gameId,
      title: cfg.title,
      total: cfg.questionIds.length,
      hostName: cfg.hostName,
      spectator: c.spectator,
      resumed,
      fromSeq: lastSeq,
      phase: st.phase,
      players,
      gateway: config.instanceId,
      leader: st.leader || null,
      token: st.token || null,
      you: { score: Number(score || 0), rank: rank === null ? null : rank + 1, alive: alive === 1, answered: answered ? Number(answered.split('|')[0]) : null },
    });

    for (const [, fields] of entries) {
      const raw = fields[1];
      const s = Number(JSON.parse(raw).seq);
      if (s <= c.seq) continue;
      if (send(c, raw, 'replay')) {
        c.seq = s;
        mReplayed.inc();
      }
    }
    for (const [msg, raw] of c.buffer) {
      if (msg.seq && msg.seq <= c.seq) continue;
      if (send(c, raw, msg.type) && msg.seq) c.seq = msg.seq;
    }
    c.buffer = [];
    c.joining = false;
  }

  // ---------- answers ----------

  async function answer(c, data, recvAt = Date.now()) {
    const ack = (status, extra = {}) => sendJson(c, { type: 'answer_ack', q: data.q, status, recvAt, ...extra });
    const room = c.gameId ? rooms.get(c.gameId) : null;
    if (!room) return ack('NOT_IN_GAME');
    if (c.spectator) return mAnswers.labels('spectator').inc(), ack('SPECTATOR');
    if (!c.bucket.take()) return mAnswers.labels('rate_limited').inc(), ack('RATE_LIMITED');
    const st = room.state;
    const q = Number(data.q);
    const choice = Number(data.choice);
    if (st.phase !== 'QUESTION' && !(st.phase === 'LOCKED' && recvAt <= st.deadline + config.answerGraceMs)) {
      mAnswers.labels(q === st.q ? 'too_late' : 'not_open').inc();
      return ack(q === st.q ? 'TOO_LATE' : 'NOT_OPEN');
    }
    if (q !== st.q) return mAnswers.labels('not_open').inc(), ack('NOT_OPEN');
    if (recvAt > st.deadline + config.answerGraceMs) return mAnswers.labels('too_late').inc(), ack('TOO_LATE');
    if (!Number.isInteger(choice) || choice < 0 || choice > 3) return mAnswers.labels('invalid').inc(), ack('INVALID');
    if (c.answered.has(q)) return mAnswers.labels('duplicate').inc(), ack('ALREADY_ANSWERED', { choice: c.answered.get(q) });
    c.answered.set(q, choice);

    // One answer = one trace: this span starts it; the engine continues it (traceparent in the entry).
    const span = tracer().startSpan('ws.answer', { kind: SpanKind.SERVER, attributes: { 'game.id': c.gameId, 'question.index': q, 'answer.choice': choice, 'user.id': c.user.id, 'gateway': config.instanceId, 'answer.ms_before_deadline': st.deadline - recvAt } });
    const ctx = trace.setSpan(context.active(), span);
    const traceId = span.isRecording() ? span.spanContext().traceId : undefined;
    try {
      await context.with(ctx, async () => {
        const xspan = tracer().startSpan('redis XADD answers', { kind: SpanKind.PRODUCER, attributes: { 'db.system': 'redis', 'messaging.destination': keys.answers(c.gameId) } });
        const tp = traceId ? await context.with(trace.setSpan(context.active(), xspan), () => currentTraceparent()) : '';
        try {
          await pub.xadd(keys.answers(c.gameId), 'MAXLEN', '~', 200000, '*', 'u', c.user.id, 'q', q, 'c', choice, 't', recvAt, 'g', config.instanceId, ...(tp ? ['tp', tp] : []));
        } finally {
          xspan.end();
        }
      });
      mAnswers.labels('received').inc();
      counters.answers++;
      // Sampled answers are also logged, inside the span, so the log line carries the trace id.
      if (traceId) context.with(ctx, () => logger.info({ gameId: c.gameId, q, choice, user: c.user.id, msBeforeDeadline: st.deadline - recvAt }, 'answer received'));
      ack('RECEIVED', { choice, traceId });
    } catch (err) {
      c.answered.delete(q);
      span.recordException(err);
      mAnswers.labels('error').inc();
      ack('ERROR', { message: 'Could not save your answer, try again' });
    } finally {
      span.end();
    }
  }

  // ---------- the WebSocket server ----------

  const server = http.createServer((req, res) => {
    if (req.url === '/metrics') return metricsHandler(req, res);
    if (req.url === '/health') {
      redis
        .ping()
        .then(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', instance: config.instanceId, connections: clients.size }));
        })
        .catch(() => {
          res.writeHead(503).end(JSON.stringify({ status: 'degraded', instance: config.instanceId }));
        });
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });

  server.on('upgrade', async (req, socket, head) => {
    const reject = (code, reason) => {
      mConnects.labels(reason).inc();
      socket.write(`HTTP/1.1 ${code} ${code === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${reason}`);
      socket.destroy();
    };
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname !== '/ws') return reject(403, 'bad_path');
      // Cross-site WebSocket hijacking protection: browsers always send Origin; only our own pages may connect.
      const origin = req.headers.origin;
      if (origin && !config.allowedOrigins.includes(origin)) return reject(403, 'bad_origin');
      const ticket = url.searchParams.get('ticket');
      if (!ticket) return reject(401, 'no_ticket');
      const raw = await redis.getdel(keys.wsTicket(ticket)); // one-time: a replayed ticket finds nothing
      if (!raw) return reject(401, 'bad_ticket');
      const user = JSON.parse(raw);
      wss.handleUpgrade(req, socket, head, (ws) => {
        mConnects.labels('ok').inc();
        onConnection(ws, user);
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'upgrade failed');
      reject(403, 'error');
    }
  });

  function onConnection(ws, user) {
    const c = { ws, user, gameId: null, seq: 0, spectator: true, joining: false, buffer: [], answered: new Map(), bucket: new Bucket(config.answerBurst, config.answerPerSec), alive: true };
    clients.add(c);
    ws.on('pong', () => {
      c.alive = true;
    });
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return sendJson(c, { type: 'error', code: 'BAD_JSON', message: 'Messages must be JSON' });
      }
      switch (msg.type) {
        case 'ping':
          return sendJson(c, { type: 'pong', t0: msg.t0, serverTime: Date.now() });
        case 'join':
          if (typeof msg.gameId !== 'string' || !/^[0-9a-f-]{36}$/.test(msg.gameId)) return sendJson(c, { type: 'error', code: 'BAD_GAME', message: 'Unknown game id' });
          c.joinPromise = join(c, msg.gameId, Number(msg.lastSeq) || 0).catch((err) => {
            c.joining = false;
            logger.warn({ err: err.message }, 'join failed');
            sendJson(c, { type: 'error', code: 'JOIN_FAILED', message: 'Could not join, retrying helps' });
          });
          return c.joinPromise;
        case 'answer': {
          // The receive time is taken NOW, even if the join (sent just before) is still being processed.
          const recvAt = Date.now();
          return Promise.resolve(c.joinPromise)
            .then(() => answer(c, msg, recvAt))
            .catch((err) => logger.warn({ err: err.message }, 'answer failed'));
        }
        case 'leave':
          return leaveRoom(c);
        default:
          return sendJson(c, { type: 'error', code: 'UNKNOWN_TYPE', message: `Unknown message type ${msg.type}` });
      }
    });
    ws.on('close', () => {
      clients.delete(c);
      leaveRoom(c);
    });
    ws.on('error', () => {});
    sendJson(c, { type: 'welcome', gateway: config.instanceId, user: { id: user.id, name: user.name, role: user.role }, serverTime: Date.now() });
  }

  // Heartbeats: ping every socket; a socket that did not answer the previous ping is dead.
  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, config.heartbeatSec * 1000);

  // Lobby presence: how many players have joined (once a second, per room still waiting).
  const presence = setInterval(async () => {
    for (const [gameId, room] of rooms) {
      if (room.state.phase !== 'LOBBY') continue;
      const players = await redis.scard(keys.players(gameId)).catch(() => null);
      if (players === null) continue;
      const raw = JSON.stringify({ type: 'presence', gameId, players });
      for (const c of room.clients) send(c, raw, 'presence');
      // A game that started while we were only watching the lobby: refresh the state.
      const st = normaliseState(await redis.hgetall(keys.gameState(gameId)).catch(() => ({})));
      if (st.seq > room.state.seq) room.state = st;
    }
  }, 1000);

  // Rolling numbers for the dashboard.
  let lastAnswers = 0;
  let lastSent = 0;
  const window = { answersPerSec: 0, sentPerSec: 0 };
  const rate = setInterval(() => {
    window.answersPerSec = counters.answers - lastAnswers;
    window.sentPerSec = counters.sent - lastSent;
    lastAnswers = counters.answers;
    lastSent = counters.sent;
  }, 1000);

  server.listen(config.port, () => logger.info({ port: config.port }, 'gateway listening'));

  const ops = startOpsReporter(async () => {
    const f = counters.fanoutMs.slice(-20).sort((a, b) => a - b);
    return {
      connections: clients.size,
      rooms: [...rooms.entries()].map(([g, r]) => ({ gameId: g, clients: r.clients.size, phase: r.state.phase, q: r.state.q, seq: r.state.seq })),
      answersPerSec: window.answersPerSec,
      sentPerSec: window.sentPerSec,
      answersTotal: counters.answers,
      lastQuestionFanoutMs: f.length ? Math.round(f[f.length - 1]) : null,
      memMb: Math.round(process.memoryUsage().rss / 1e6),
    };
  });

  return async () => {
    clearInterval(ops);
    clearInterval(heartbeat);
    clearInterval(presence);
    clearInterval(rate);
    // 1012 = "service restart": clients reconnect right away (to another gateway) and resume.
    for (const c of clients) c.ws.close(1012, 'gateway restarting');
    server.close();
  };
}
