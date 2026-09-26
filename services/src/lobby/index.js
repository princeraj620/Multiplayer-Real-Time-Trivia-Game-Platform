// Lobby API: games, question packs, host controls, history, admin tools, and the dashboard data.
// Ordinary stateless REST behind Nginx (as in Project 1). Role-based access control on every route.
import { Etcd3 } from 'etcd3';
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { query, readQuery, withTx } from '../shared/db.js';
import { redis, keys } from '../shared/redis.js';
import { createApp, finishApp, ah, rateLimit, listen } from '../shared/http.js';
import { requireAuth, requireRole, startJwksRefresh, jwksStatus } from '../shared/auth.js';
import { badRequest, forbidden, notFound, conflict, AppError } from '../shared/errors.js';
import { encrypt, decrypt, keyIdOf } from '../shared/crypto.js';
import { counter, gauge } from '../shared/metrics.js';
import { startOpsReporter } from '../shared/ops.js';

const mGames = counter('buzz_lobby_games_total', 'Game lifecycle actions', ['action']);
const UUID = /^[0-9a-f-]{36}$/;

async function audit(actorId, action, target, detail = {}) {
  await query(`INSERT INTO audit_log (actor_id, action, target, detail) VALUES ($1, $2, $3, $4)`, [actorId, action, target, detail]).catch(() => {});
}

export async function start() {
  const etcd = new Etcd3({ hosts: config.etcdEndpoints, dialTimeout: 1500, defaultCallOptions: () => ({ deadline: Date.now() + 2500 }) });
  // One client per etcd member, to ask each one for its own status (who is the Raft leader, term, index).
  const memberClients = config.etcdEndpoints.map((host) => ({ host, client: new Etcd3({ hosts: [host], dialTimeout: 800, defaultCallOptions: () => ({ deadline: Date.now() + 800 }) }) }));
  await startJwksRefresh();

  // For the "LiveGameWithoutLeader" alert: live games whose leader has not written a heartbeat for 3 s.
  async function liveGameHealth() {
    const live = (await query(`SELECT id FROM games WHERE status = 'LIVE'`)).rows;
    let stale = 0;
    for (const g of live) {
      const beat = Number((await redis.hget(keys.gameState(g.id), 'beat')) || 0);
      if (!beat || Date.now() - beat > 3000) stale++;
    }
    return { live: live.length, stale };
  }
  gauge('buzz_live_games', 'Games on air', [], async function collect() {
    this.set((await liveGameHealth().catch(() => ({ live: 0 }))).live);
  });
  gauge('buzz_live_games_without_leader', 'Live games with no leader heartbeat for 3 s', [], async function collect() {
    this.set((await liveGameHealth().catch(() => ({ stale: 0 }))).stale);
  });

  const app = createApp({
    health: async () => ({
      postgres: await query('SELECT 1').then(() => 'ok').catch(() => 'down'),
      replica: await readQuery('SELECT 1').then((r) => (r.readFrom === 'replica' ? 'ok' : 'fallback-to-primary')).catch(() => 'down'),
      redis: await redis.ping().then(() => 'ok').catch(() => 'down'),
      signingKeys: jwksStatus().keys.length ? 'ok' : 'missing',
    }),
  });
  const auth = requireAuth;

  // ---------- games ----------

  async function gameConfigFor(game, hostName) {
    return { title: game.title, hostId: game.host_id, hostName, packId: game.pack_id, questionIds: game.question_ids, questionSec: game.question_sec };
  }

  async function withLive(rows) {
    if (!rows.length) return rows;
    const p = redis.pipeline();
    for (const g of rows) {
      p.scard(keys.players(g.id));
      p.hmget(keys.gameState(g.id), 'phase', 'q', 'leader', 'token');
    }
    const res = await p.exec();
    return rows.map((g, i) => {
      const [phase, q, leader, token] = res[i * 2 + 1][1] || [];
      return { ...g, players: g.status === 'FINISHED' ? g.player_count : Number(res[i * 2][1] || 0), live: phase ? { phase, q: Number(q || 0), leader, token: Number(token || 0) } : null };
    });
  }

  const gameCols = `g.id, g.title, g.status, g.question_sec, cardinality(g.question_ids) AS question_count, g.scheduled_at, g.started_at, g.finished_at,
    g.player_count, g.survivor_count, g.host_id, u.name AS host_name, p.title AS pack_title, p.emoji AS pack_emoji, p.category`;

  app.get('/api/games', ah(async (req, res) => {
    const status = String(req.query.status || 'open');
    const where = status === 'finished' ? `g.status = 'FINISHED'` : status === 'all' ? `true` : `g.status IN ('SCHEDULED','LIVE')`;
    const order = status === 'finished' ? 'g.finished_at DESC' : `(g.status = 'LIVE') DESC, g.scheduled_at`;
    const r = await query(`SELECT ${gameCols} FROM games g JOIN users u ON u.id = g.host_id JOIN question_packs p ON p.id = g.pack_id WHERE ${where} ORDER BY ${order} LIMIT 30`);
    res.json({ games: await withLive(r.rows) });
  }));

  app.get('/api/games/:id', ah(async (req, res) => {
    if (!UUID.test(req.params.id)) throw notFound('No such game');
    const r = await query(`SELECT ${gameCols} FROM games g JOIN users u ON u.id = g.host_id JOIN question_packs p ON p.id = g.pack_id WHERE g.id = $1`, [req.params.id]);
    if (!r.rowCount) throw notFound('No such game');
    const [game] = await withLive(r.rows);
    res.json({ game });
  }));

  app.post('/api/games', auth, requireRole('host', 'admin'), rateLimit('create-game', 5, 0.2, (req) => req.user.id), ah(async (req, res) => {
    const { title, packId, questionCount = 8, questionSec = config.questionSec } = req.body || {};
    if (!title || String(title).trim().length < 3 || String(title).length > 60) throw badRequest('Title must be 3-60 characters');
    const n = Math.min(Math.max(Number(questionCount) || 8, 2), 20);
    const sec = Math.min(Math.max(Number(questionSec) || 10, 5), 60);
    const qs = await query(`SELECT id FROM questions WHERE pack_id = $1 ORDER BY random() LIMIT $2`, [Number(packId), n]);
    if (qs.rowCount < 2) throw badRequest('That pack has too few questions');
    const g = (await query(
      `INSERT INTO games (title, host_id, pack_id, question_ids, question_sec) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [String(title).trim(), req.user.id, Number(packId), qs.rows.map((r) => r.id), sec],
    )).rows[0];
    await redis.multi().set(keys.gameConfig(g.id), JSON.stringify(await gameConfigFor(g, req.user.name))).hset(keys.gameState(g.id), 'phase', 'LOBBY', 'seq', 0).exec();
    mGames.labels('created').inc();
    await audit(req.user.id, 'game_created', g.id, { title: g.title });
    res.status(201).json({ game: { id: g.id, title: g.title, status: g.status } });
  }));

  async function loadOwnGame(req) {
    if (!UUID.test(req.params.id)) throw notFound('No such game');
    const g = (await query(`SELECT g.*, u.name AS host_name FROM games g JOIN users u ON u.id = g.host_id WHERE g.id = $1`, [req.params.id])).rows[0];
    if (!g) throw notFound('No such game');
    // Authorization beyond the role: a host may only control THEIR OWN games; admins may control any.
    if (req.user.role !== 'admin' && g.host_id !== req.user.id) throw forbidden('Only the host of this game can do that', 'NOT_YOUR_GAME');
    return g;
  }

  app.post('/api/games/:id/start', auth, requireRole('host', 'admin'), ah(async (req, res) => {
    const g = await loadOwnGame(req);
    if (g.status !== 'SCHEDULED') throw conflict('GAME_NOT_SCHEDULED', `The game is ${g.status}`);
    await withTx(async (c) => {
      const u = await c.query(`UPDATE games SET status = 'LIVE', started_at = now() WHERE id = $1 AND status = 'SCHEDULED' RETURNING id`, [g.id]);
      if (!u.rowCount) throw conflict('GAME_NOT_SCHEDULED', 'The game was already started');
      if (!(await redis.exists(keys.gameConfig(g.id)))) {
        await redis.multi().set(keys.gameConfig(g.id), JSON.stringify(await gameConfigFor(g, g.host_name))).hsetnx(keys.gameState(g.id), 'phase', 'LOBBY').exec();
      }
      // Hand the game to the engines: they watch this etcd prefix and one of them wins the election.
      try {
        await etcd.put(`/buzzarena/games/${g.id}`).value(JSON.stringify({ id: g.id, title: g.title, startedBy: req.user.id, at: Date.now() }));
      } catch (err) {
        throw new AppError(503, 'COORDINATION_UNAVAILABLE', 'The engines cannot be reached right now (etcd has no majority). Try again in a moment.', { err: err.message });
      }
    });
    mGames.labels('started').inc();
    await audit(req.user.id, 'game_started', g.id);
    logger.info({ gameId: g.id, by: req.user.id }, 'game started');
    res.json({ ok: true, gameId: g.id });
  }));

  app.post('/api/games/:id/cancel', auth, requireRole('host', 'admin'), ah(async (req, res) => {
    const g = await loadOwnGame(req);
    const u = await query(`UPDATE games SET status = 'CANCELLED' WHERE id = $1 AND status = 'SCHEDULED' RETURNING id`, [g.id]);
    if (!u.rowCount) throw conflict('GAME_NOT_SCHEDULED', 'Only scheduled games can be cancelled');
    await redis.del(keys.gameConfig(g.id), keys.gameState(g.id));
    await audit(req.user.id, 'game_cancelled', g.id);
    res.json({ ok: true });
  }));

  // The host console: the current question WITH its answer (the host is allowed to see it) and the live split.
  app.get('/api/games/:id/host', auth, requireRole('host', 'admin'), ah(async (req, res) => {
    const g = await loadOwnGame(req);
    const st = await redis.hgetall(keys.gameState(g.id));
    const q = Number(st.q || 0);
    const qid = g.question_ids[q];
    const question = qid ? (await query(`SELECT id, text, options, correct_enc, fact FROM questions WHERE id = $1`, [qid])).rows[0] : null;
    const [dist, answered, players, survivors, lag] = await Promise.all([
      redis.hgetall(keys.dist(g.id, q)),
      redis.hlen(keys.answered(g.id, q)),
      redis.scard(keys.players(g.id)),
      redis.scard(keys.alive(g.id)),
      redis.xlen(keys.answers(g.id)).catch(() => 0),
    ]);
    res.json({
      game: { id: g.id, title: g.title, status: g.status, total: g.question_ids.length },
      state: { phase: st.phase || 'LOBBY', q, deadline: Number(st.deadline || 0), leader: st.leader || null, token: Number(st.token || 0), seq: Number(st.seq || 0) },
      question: question ? { index: q, text: question.text, options: question.options, correct: Number(decrypt(question.correct_enc, String(question.id))), fact: question.fact } : null,
      dist: question ? question.options.map((_, i) => Number(dist[i] || 0)) : [],
      answered,
      players,
      survivors,
      answersInStream: lag,
    });
  }));

  app.get('/api/games/:id/results', ah(async (req, res) => {
    if (!UUID.test(req.params.id)) throw notFound('No such game');
    const g = (await readQuery(`SELECT id, title, status, player_count, survivor_count, finished_at, finished_by, cardinality(question_ids) AS question_count FROM games WHERE id = $1`, [req.params.id]));
    if (!g.rowCount) throw notFound('No such game');
    const top = await readQuery(
      `SELECT r.rank, r.score, r.correct_count, r.survived, u.name, u.id AS user_id FROM game_results r JOIN users u ON u.id = r.user_id WHERE r.game_id = $1 ORDER BY r.rank LIMIT 20`,
      [req.params.id],
    );
    res.setHeader('X-Read-From', g.readFrom);
    res.json({ game: g.rows[0], top: top.rows });
  }));

  // ---------- players ----------

  app.get('/api/me/history', auth, ah(async (req, res) => {
    const r = await readQuery(
      `SELECT g.id, g.title, g.finished_at, g.player_count, r.rank, r.score, r.correct_count, r.survived, cardinality(g.question_ids) AS question_count
         FROM game_results r JOIN games g ON g.id = r.game_id WHERE r.user_id = $1 ORDER BY g.finished_at DESC LIMIT 20`,
      [req.user.id],
    );
    res.setHeader('X-Read-From', r.readFrom);
    res.json({ history: r.rows });
  }));

  app.get('/api/leaderboard', ah(async (req, res) => {
    const r = await readQuery(
      `SELECT u.id, u.name, sum(r.score)::int AS total, count(*)::int AS games, count(*) FILTER (WHERE r.rank = 1)::int AS wins
         FROM game_results r JOIN users u ON u.id = r.user_id WHERE NOT u.is_bot
        GROUP BY u.id, u.name ORDER BY total DESC LIMIT 15`,
    );
    res.setHeader('X-Read-From', r.readFrom);
    res.json({ leaderboard: r.rows });
  }));

  // ---------- question packs ----------

  app.get('/api/packs', ah(async (req, res) => {
    const r = await query(`SELECT p.id, p.slug, p.title, p.category, p.description, p.emoji, count(q.id)::int AS questions FROM question_packs p LEFT JOIN questions q ON q.pack_id = p.id GROUP BY p.id ORDER BY p.id`);
    res.json({ packs: r.rows });
  }));

  app.get('/api/packs/:id/questions', auth, requireRole('admin'), ah(async (req, res) => {
    const r = await query(`SELECT id, text, options, correct_enc, fact, difficulty FROM questions WHERE pack_id = $1 ORDER BY id`, [Number(req.params.id)]);
    res.json({
      questions: r.rows.map((q) => ({ id: q.id, text: q.text, options: q.options, correct: Number(decrypt(q.correct_enc, String(q.id))), keyId: keyIdOf(q.correct_enc), ciphertext: q.correct_enc.slice(0, 48) + '…', fact: q.fact, difficulty: q.difficulty })),
    });
  }));

  app.post('/api/packs/:id/questions', auth, requireRole('admin'), ah(async (req, res) => {
    const { text, options, correct, fact } = req.body || {};
    if (!text || !Array.isArray(options) || options.length < 2 || options.length > 4) throw badRequest('A question needs text and 2-4 options');
    if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) throw badRequest('correct must be the index of an option');
    const q = await withTx(async (c) => {
      const ins = await c.query(`INSERT INTO questions (pack_id, text, options, correct_enc, fact) VALUES ($1, $2, $3, 'pending', $4) RETURNING id`, [Number(req.params.id), text, options, fact || null]);
      const id = ins.rows[0].id;
      await c.query(`UPDATE questions SET correct_enc = $2 WHERE id = $1`, [id, encrypt(String(correct), String(id))]);
      return id;
    });
    await audit(req.user.id, 'question_added', String(q), { pack: Number(req.params.id) });
    res.status(201).json({ id: q });
  }));

  // ---------- admin ----------

  app.get('/api/admin/users', auth, requireRole('admin'), ah(async (req, res) => {
    const r = await query(`SELECT id, email, name, role, created_at FROM users WHERE NOT is_bot ORDER BY created_at LIMIT 100`);
    res.json({ users: r.rows });
  }));

  app.patch('/api/admin/users/:id/role', auth, requireRole('admin'), ah(async (req, res) => {
    const role = String(req.body?.role || '');
    if (!['player', 'host', 'admin'].includes(role)) throw badRequest('role must be player, host or admin');
    if (req.params.id === req.user.id) throw badRequest('You cannot change your own role');
    const r = await query(`UPDATE users SET role = $2 WHERE id = $1 RETURNING id, name, role`, [req.params.id, role]);
    if (!r.rowCount) throw notFound('No such user');
    // Sign the user out everywhere, so the new role takes effect at their next login/refresh.
    await query(`UPDATE refresh_tokens SET status = 'REVOKED' WHERE user_id = $1 AND status = 'ACTIVE'`, [req.params.id]);
    await audit(req.user.id, 'role_changed', req.params.id, { role });
    res.json({ user: r.rows[0] });
  }));

  app.get('/api/admin/audit', auth, requireRole('admin'), ah(async (req, res) => {
    const r = await query(`SELECT a.at, a.action, a.target, a.detail, u.name AS actor FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.at DESC LIMIT 50`);
    res.json({ audit: r.rows });
  }));

  // ---------- the live dashboard ----------

  let overviewCache = { at: 0, data: null };
  async function etcdMembers() {
    return Promise.all(
      memberClients.map(async ({ host, client }) => {
        const t0 = Date.now();
        try {
          const s = await client.maintenance.status();
          return { host, up: true, id: s.header.member_id, isLeader: s.leader === s.header.member_id, leader: s.leader, raftTerm: Number(s.raftTerm), raftIndex: Number(s.raftIndex), dbSize: Number(s.dbSize), ms: Date.now() - t0 };
        } catch (err) {
          return { host, up: false, error: err.message.slice(0, 80) };
        }
      }),
    );
  }

  async function alerts() {
    try {
      const r = await fetch(`${config.prometheusUrl}/api/v1/alerts`, { signal: AbortSignal.timeout(500) });
      const j = await r.json();
      return j.data.alerts.map((a) => ({ name: a.labels.alertname, state: a.state, severity: a.labels.severity, summary: a.annotations?.summary, since: a.activeAt }));
    } catch {
      return null;
    }
  }

  app.get('/api/ops/overview', ah(async (req, res) => {
    if (Date.now() - overviewCache.at < 700 && overviewCache.data) return res.json(overviewCache.data);
    const instKeys = [];
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', 'ops:*', 'COUNT', 200);
      cursor = next;
      instKeys.push(...batch);
    } while (cursor !== '0');
    const insts = instKeys.length ? (await redis.mget(...instKeys)).filter(Boolean).map((s) => JSON.parse(s)) : [];
    const by = (svc) => insts.filter((i) => i.service === svc).sort((a, b) => a.instance.localeCompare(b.instance));

    const [members, leaders, liveGames, promAlerts, pgStats] = await Promise.all([
      etcdMembers(),
      etcd.getAll().prefix('/buzzarena/leaders/').exec().then((r) => r.kvs.map((kv) => ({ gameId: kv.key.toString().split('/').pop(), engine: kv.value.toString(), token: Number(kv.create_revision), lease: kv.lease }))).catch(() => null),
      query(`SELECT g.id, g.title, g.leader_token, cardinality(g.question_ids) AS total, u.name AS host FROM games g JOIN users u ON u.id = g.host_id WHERE g.status = 'LIVE' ORDER BY g.started_at DESC LIMIT 6`).then((r) => r.rows).catch(() => []),
      alerts(),
      query(`SELECT (SELECT count(*) FROM games WHERE status='FINISHED')::int AS finished, (SELECT count(*) FROM users WHERE NOT is_bot)::int AS users,
                    (SELECT count(*) FROM refresh_tokens WHERE status='ACTIVE')::int AS sessions,
                    (SELECT client_addr IS NOT NULL FROM pg_stat_replication LIMIT 1) AS replica_connected,
                    (SELECT EXTRACT(EPOCH FROM replay_lag) * 1000 FROM pg_stat_replication LIMIT 1) AS replica_lag_ms`).then((r) => r.rows[0]).catch(() => null),
    ]);

    const games = [];
    for (const g of liveGames) {
      const [st, players, survivors, answered, xlen] = await Promise.all([
        redis.hgetall(keys.gameState(g.id)),
        redis.scard(keys.players(g.id)),
        redis.scard(keys.alive(g.id)),
        redis.hgetall(keys.gameState(g.id)).then((s) => redis.hlen(keys.answered(g.id, Number(s.q || 0)))),
        redis.xlen(keys.answers(g.id)).catch(() => 0),
      ]);
      games.push({ ...g, phase: st.phase, q: Number(st.q || 0), seq: Number(st.seq || 0), leader: st.leader, token: Number(st.token || 0), fence: Number((await redis.get(keys.fence(g.id))) || 0), beatMsAgo: st.beat ? Date.now() - Number(st.beat) : null, deadline: Number(st.deadline || 0), players, survivors, answered, answersInStream: xlen, etcdLeader: leaders?.find((l) => l.gameId === g.id) || null });
    }

    const data = {
      at: Date.now(),
      gateways: by('gateway'),
      engines: by('engine'),
      lobbies: by('lobby'),
      auths: by('auth'),
      etcd: { members, leaders },
      games,
      alerts: promAlerts,
      postgres: pgStats,
      links: { jaeger: config.jaegerUiUrl, grafana: config.grafanaUrl, prometheus: config.prometheusUiUrl },
    };
    overviewCache = { at: Date.now(), data };
    res.json(data);
  }));

  finishApp(app);
  const server = await listen(app, config.port);
  const ops = startOpsReporter(async () => ({ jwks: jwksStatus() }));
  return async () => {
    clearInterval(ops);
    server.close();
    etcd.close();
    for (const m of memberClients) m.client.close();
  };
}
