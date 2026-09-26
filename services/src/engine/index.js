// Game engine: competes (through etcd) to lead games, then runs them.
//
// Several engines run at once. Each live game has exactly one leader; the others stand by. The list
// of games that need a leader lives in etcd under /buzzarena/games/ (the lobby adds a game when the
// host presses Start, the leader removes it when the game ends).
import http from 'node:http';
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { redis, keys } from '../shared/redis.js';
import { query } from '../shared/db.js';
import { counter, gauge, metricsHandler } from '../shared/metrics.js';
import { startOpsReporter } from '../shared/ops.js';
import { createEtcd, Elector, PREFIX } from './election.js';
import { GameRunner, m } from './game.js';

const mElections = counter('buzz_engine_elections_total', 'Leadership campaigns', ['result']);
const mLeaseLost = counter('buzz_engine_lease_lost_total', 'Times this engine lost its etcd lease');

export async function start() {
  const client = createEtcd();
  const elector = new Elector(client, config.instanceId, config.leaseTtlSec);
  const runners = new Map(); // gameId -> GameRunner
  const pending = new Map(); // gameId -> timeout (a campaign is scheduled)
  let recent = []; // recent events for the dashboard

  const note = (event) => {
    recent.unshift({ at: Date.now(), ...event });
    recent = recent.slice(0, 20);
  };

  gauge('buzz_engine_games_led', 'Games this engine leads right now', [], function collect() {
    this.set(runners.size);
  });
  gauge('buzz_engine_lease_healthy', '1 if this engine can prove its etcd lease is alive', [], function collect() {
    this.set(elector.isHealthy() ? 1 : 0);
  });

  elector.on('lost', (reason) => {
    mLeaseLost.inc();
    note({ type: 'lease-lost', reason });
    for (const r of [...runners.values()]) r.stop('lease lost');
  });

  function onStop(runner, reason) {
    if (runners.get(runner.g) === runner) runners.delete(runner.g);
    note({ type: 'stepped-down', gameId: runner.g, token: runner.token, reason });
    if (reason.startsWith('fenced') || reason === 'self-fenced' || reason === 'lease lost') {
      // Our leadership is gone. If the key is still ours (fenced by an even newer write) give it up.
      elector.resign(runner.g, runner.token).catch(() => {});
    }
  }

  async function campaign(gameId) {
    pending.delete(gameId);
    if (runners.has(gameId)) return;
    let token;
    try {
      token = await elector.campaign(gameId);
    } catch (err) {
      mElections.labels('error').inc();
      logger.debug({ err: err.message, gameId }, 'campaign failed (etcd unavailable?)');
      return;
    }
    if (!token) {
      mElections.labels('lost').inc();
      return;
    }
    mElections.labels('won').inc();
    note({ type: 'elected', gameId, token });
    logger.info({ gameId, token }, 'elected leader');
    const runner = new GameRunner({ gameId, token, engineId: config.instanceId, elector, onStop });
    runners.set(gameId, runner);
    runner.start().catch((err) => {
      logger.warn({ err: err.message, gameId, token }, err.fenced ? 'fenced right after winning: an even newer leader exists' : 'could not start the game');
      runner.stop(err.fenced ? `fenced by ${err.where}` : 'start failed');
      if (!err.fenced) elector.resign(gameId, token).catch(() => {});
    });
  }

  /** A game needs a leader: campaign after a small delay. Engines that already lead many games wait longer, which spreads games across engines. */
  function consider(gameId) {
    if (runners.has(gameId) || pending.has(gameId) || !elector) return;
    const delay = config.campaignDelayPerGameMs * runners.size + Math.floor(Math.random() * 150);
    pending.set(gameId, setTimeout(() => campaign(gameId), delay));
  }

  async function resync() {
    try {
      const games = await client.getAll().prefix(`${PREFIX}games/`).keys();
      const leaders = new Set((await client.getAll().prefix(`${PREFIX}leaders/`).keys()).map((k) => k.slice(`${PREFIX}leaders/`.length)));
      for (const k of games) {
        const g = k.slice(`${PREFIX}games/`.length);
        if (!leaders.has(g)) consider(g);
      }
    } catch {
      /* etcd unavailable: try again next time */
    }
  }

  async function watch() {
    try {
      const watcher = await client.watch().prefix(PREFIX).create();
      watcher.on('put', (kv) => {
        const key = kv.key.toString();
        if (key.startsWith(`${PREFIX}games/`)) consider(key.slice(`${PREFIX}games/`.length));
      });
      watcher.on('delete', (kv) => {
        const key = kv.key.toString();
        if (key.startsWith(`${PREFIX}leaders/`)) {
          const g = key.slice(`${PREFIX}leaders/`.length);
          note({ type: 'leader-gone', gameId: g });
          consider(g);
        }
      });
      watcher.on('error', () => {});
    } catch (err) {
      logger.warn({ err: err.message }, 'etcd watch failed, retrying in 2 s');
      setTimeout(watch, 2000);
    }
  }

  // Keep a lease open even when idle, so the dashboard can show this engine's health.
  const leaseLoop = setInterval(() => elector.ensureLease().catch(() => {}), 1000);
  await elector.ensureLease().catch((err) => logger.warn({ err: err.message }, 'etcd not reachable yet'));
  await watch();
  await resync();
  const resyncTimer = setInterval(resync, 2000);

  // Stream lag per game, for the dashboard and Prometheus.
  const lagTimer = setInterval(async () => {
    for (const r of runners.values()) {
      try {
        const groups = await redis.xinfo('GROUPS', keys.answers(r.g));
        const g = groups.find((x) => x[1] === 'engine');
        const idx = g ? g.indexOf('lag') : -1;
        const lag = idx >= 0 ? Number(g[idx + 1] || 0) : 0;
        r.lag = lag;
        m.lag.labels(r.g.slice(0, 8)).set(lag);
      } catch {
        /* ignore */
      }
    }
  }, 1000);

  const server = http.createServer((req, res) => {
    if (req.url === '/metrics') return metricsHandler(req, res);
    if (req.url === '/health') {
      const ok = elector.isHealthy();
      res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: ok ? 'ok' : 'degraded', instance: config.instanceId, election: elector.status(), games: [...runners.values()].map((r) => r.snapshot()) }));
    }
    res.writeHead(404).end();
  });
  server.listen(config.port, () => logger.info({ port: config.port }, 'engine listening (health + metrics)'));

  const ops = startOpsReporter(async () => ({
    election: elector.status(),
    games: [...runners.values()].map((r) => ({ ...r.snapshot(), lag: r.lag || 0, processed: r.stats.processed })),
    recent: recent.slice(0, 8),
  }));

  // Postgres is only needed while leading; check it at startup so a misconfiguration shows early.
  query('SELECT 1').catch((err) => logger.warn({ err: err.message }, 'postgres not reachable yet'));

  return async () => {
    clearInterval(ops);
    clearInterval(resyncTimer);
    clearInterval(lagTimer);
    clearInterval(leaseLoop);
    for (const t of pending.values()) clearTimeout(t);
    // A clean shutdown hands games over at once instead of waiting for the lease to expire.
    for (const r of [...runners.values()]) {
      r.stop('shutdown');
      await elector.resign(r.g, r.token);
    }
    elector.close();
    server.close();
  };
}
