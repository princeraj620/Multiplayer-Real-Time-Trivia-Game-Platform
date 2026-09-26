// One game, run by its leader engine.
//
// The game is a state machine:
//   COUNTDOWN → QUESTION → LOCKED → REVEAL → LEADERBOARD → (next QUESTION …) → FINISHED
//
// After every step the leader saves a checkpoint in Redis (phase, question number, deadline…) in the
// same Lua script that publishes the message. If this engine dies, the next leader reads the checkpoint
// and continues from exactly that point: a question that was open stays open until its original deadline.
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { redis, keys, createRedis } from '../shared/redis.js';
import { query, withTx } from '../shared/db.js';
import { decrypt } from '../shared/crypto.js';
import { traced, tracer, contextFromTraceparent, SpanKind, context, trace } from '../shared/tracing.js';
import { counter, histogram, gauge } from '../shared/metrics.js';

export const m = {
  phases: counter('buzz_engine_phase_transitions_total', 'Game phase changes published', ['phase']),
  answers: counter('buzz_engine_answers_total', 'Answers processed by the engine', ['result']),
  fenced: counter('buzz_engine_fenced_writes_total', 'Writes rejected because a newer leader exists', ['store']),
  scoring: histogram('buzz_engine_scoring_seconds', 'Time to score one question', [], [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5]),
  takeover: histogram('buzz_engine_takeover_gap_seconds', 'Silence between the old leader and the new one', [], [0.5, 1, 2, 3, 4, 5, 6, 8, 10, 15]),
  lag: gauge('buzz_engine_answer_stream_lag', 'Answers waiting in the stream', ['game']),
  playersScored: counter('buzz_engine_players_scored_total', 'Player scores written'),
};

export class FencedError extends Error {
  constructor(where) {
    super(where === 'self' ? 'lease not renewed in time: stopping before writing (self-fencing)' : `write rejected: a newer leader's token is in ${where}`);
    this.fenced = true;
    this.where = where;
  }
}
const stopReason = (err) => (err.where === 'self' ? 'self-fenced' : err.where === 'stopped' ? 'stopped' : `fenced by ${err.where}`);

const now = () => Date.now();

export class GameRunner {
  constructor({ gameId, token, engineId, elector, onStop }) {
    this.g = gameId;
    this.token = token;
    this.engineId = engineId;
    this.elector = elector;
    this.onStop = onStop;
    this.running = false;
    this.timers = new Set();
    this.state = {};
    this.stats = { processed: 0, accepted: 0 };
    this.log = logger.child({ gameId, token });
  }

  // ---------- lifecycle ----------

  async start() {
    this.running = true;
    const fence = await redis.claimFence(keys.fence(this.g), this.token);
    if (Number(fence) > this.token) throw new FencedError('redis');
    // Fence the database too: from now on only tokens >= ours can write this game's results.
    const pg = await query(`UPDATE games SET leader_token = $2 WHERE id = $1 AND leader_token <= $2 RETURNING status`, [this.g, this.token]);
    if (!pg.rowCount) throw new FencedError('postgres');

    this.cfg = JSON.parse((await redis.get(keys.gameConfig(this.g))) || 'null');
    if (!this.cfg) throw new Error('game config missing in Redis');
    const qs = (await query(`SELECT id, text, options, correct_enc, fact FROM questions WHERE id = ANY($1)`, [this.cfg.questionIds])).rows;
    const byId = new Map(qs.map((q) => [q.id, q]));
    this.questions = this.cfg.questionIds.map((id) => byId.get(id));
    this.questionMs = (this.cfg.questionSec || config.questionSec) * 1000;

    this.state = await redis.hgetall(keys.gameState(this.g));
    const silence = this.state.beat ? now() - Number(this.state.beat) : null;
    const resumed = this.state.phase && this.state.phase !== 'LOBBY';
    if (resumed && silence !== null) m.takeover.observe(silence / 1000);

    this.stream = createRedis(`stream-${this.g.slice(0, 8)}`);
    await this.stream.xgroup('CREATE', keys.answers(this.g), 'engine', '0', 'MKSTREAM').catch(() => {});

    await this.publish('leader', { engine: this.engineId, token: this.token, resumed: !!resumed, resumedPhase: this.state.phase || null, silenceMs: silence }, {});
    this.log.info({ phase: this.state.phase || 'START', silenceMs: silence }, resumed ? 'took over a running game' : 'leading a new game');

    this.beatTimer = setInterval(() => this.beat(), 500);
    this.consumeLoop();
    await this.resume();
  }

  stop(reason) {
    if (!this.running) return;
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    clearInterval(this.beatTimer);
    this.stream?.disconnect();
    this.log.info({ reason }, 'stopped leading this game');
    this.onStop?.(this, reason);
  }

  at(when, fn) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.running) this.step(fn);
    }, Math.max(0, when - now()));
    this.timers.add(t);
  }

  async step(fn) {
    try {
      await fn();
    } catch (err) {
      if (err.fenced) {
        this.log.warn({ err: err.message }, 'FENCED: stepping down');
        this.stop(stopReason(err));
      } else {
        this.log.error({ err: err.message, stack: err.stack }, 'game step failed, retrying in 1 s');
        this.at(now() + 1000, fn);
      }
    }
  }

  // ---------- writes (all fenced) ----------

  guard() {
    if (!this.running) throw new FencedError('stopped');
    if (config.selfFencing && !this.elector.isHealthy()) {
      m.fenced.labels('self').inc();
      throw new FencedError('self');
    }
  }

  async publish(type, payload, stateFields) {
    this.guard();
    const msg = JSON.stringify({ seq: 0, type, gameId: this.g, at: now(), leader: this.engineId, token: this.token, ...payload });
    const flat = [];
    for (const [k, v] of Object.entries({ ...stateFields, beat: now(), leader: this.engineId, token: this.token })) flat.push(k, v === null || v === undefined ? '' : String(v));
    const [seq] = await redis.fencedPublish(keys.fence(this.g), keys.seq(this.g), keys.gameState(this.g), keys.log(this.g), this.token, keys.channel(this.g), msg, config.resumeLogSize, ...flat);
    if (Number(seq) === -1) {
      m.fenced.labels('redis').inc();
      throw new FencedError('redis');
    }
    Object.assign(this.state, stateFields, { seq });
    if (stateFields.phase) m.phases.labels(stateFields.phase).inc();
    return seq;
  }

  async beat() {
    if (!this.running) return;
    try {
      this.guard();
      let msg = '';
      if (this.state.phase === 'QUESTION') {
        const answered = await redis.hlen(keys.answered(this.g, this.state.q));
        msg = JSON.stringify({ type: 'tally', gameId: this.g, q: Number(this.state.q), answered });
      }
      const r = await redis.fencedEphemeral(keys.fence(this.g), keys.gameState(this.g), this.token, keys.channel(this.g), msg, now());
      if (Number(r) === -1) {
        m.fenced.labels('redis').inc();
        throw new FencedError('redis');
      }
    } catch (err) {
      if (err.fenced) {
        this.log.warn({ err: err.message }, 'FENCED during heartbeat: stepping down');
        this.stop(stopReason(err));
      }
    }
  }

  // ---------- the state machine ----------

  async resume() {
    const s = this.state;
    const q = Number(s.q || 0);
    const endsAt = Number(s.phaseEndsAt || 0);
    switch (s.phase) {
      case undefined:
      case '':
      case 'LOBBY':
        return this.step(() => this.countdown());
      case 'COUNTDOWN':
        return this.at(endsAt, () => this.openQuestion(0));
      case 'QUESTION':
        return this.at(Number(s.deadline) + config.answerGraceMs + 50, () => this.lockAndScore(q));
      case 'LOCKED':
        return this.step(() => this.lockAndScore(q));
      case 'REVEAL':
        return this.at(endsAt, () => this.leaderboard(q));
      case 'LEADERBOARD':
        return this.at(endsAt, () => this.next(q));
      case 'FINISHED':
        return this.step(() => this.finish());
      default:
        this.log.warn({ phase: s.phase }, 'unknown phase in checkpoint');
    }
  }

  async countdown() {
    const endsAt = now() + config.countdownSec * 1000;
    const players = await redis.scard(keys.players(this.g));
    await this.publish('countdown', { startsAt: endsAt, total: this.questions.length, players, title: this.cfg.title }, { phase: 'COUNTDOWN', q: 0, phaseEndsAt: endsAt });
    this.at(endsAt, () => this.openQuestion(0));
  }

  async openQuestion(q) {
    const question = this.questions[q];
    const openedAt = now();
    const deadline = openedAt + this.questionMs;
    this.stats.processed = 0;
    // The correct answer is NOT in this message. Clients only learn it in the reveal, after the deadline.
    await this.publish(
      'question',
      { q, total: this.questions.length, text: question.text, options: question.options, openedAt, deadline, questionMs: this.questionMs },
      { phase: 'QUESTION', q, openedAt, deadline, phaseEndsAt: deadline },
    );
    this.at(deadline + config.answerGraceMs + 50, () => this.lockAndScore(q));
  }

  async lockAndScore(q) {
    if (this.state.phase !== 'LOCKED') await this.publish('locked', { q }, { phase: 'LOCKED', q });
    await this.waitForStream();
    const question = this.questions[q];
    const openedAt = Number(this.state.openedAt);
    const correct = Number(decrypt(question.correct_enc, String(question.id)));
    const started = process.hrtime.bigint();

    await traced('engine.score_question', { 'game.id': this.g, 'question.index': q }, async (span) => {
      const [answers, alive, players] = await Promise.all([
        redis.hgetall(keys.answered(this.g, q)),
        redis.smembers(keys.alive(this.g)),
        redis.smembers(keys.players(this.g)),
      ]);
      const aliveSet = new Set(alive);
      let batch = [];
      let correctCount = 0;
      const flush = async () => {
        if (!batch.length) return;
        const r = await redis.fencedScore(keys.fence(this.g), keys.points(this.g, q), keys.leaderboard(this.g), keys.alive(this.g), keys.correct(this.g), this.token, ...batch);
        if (Number(r) === -1) {
          m.fenced.labels('redis').inc();
          throw new FencedError('redis');
        }
        m.playersScored.inc(Number(r));
        batch = [];
      };
      for (const u of players) {
        const a = answers[u];
        let pts = 0;
        if (a) {
          const [c, t] = a.split('|').map(Number);
          if (c === correct) {
            const elapsed = Math.min(Math.max(t - openedAt, 0), this.questionMs);
            pts = 500 + Math.round(500 * (1 - elapsed / this.questionMs)); // 500-1000: faster = more
            correctCount++;
          }
        }
        batch.push(u, pts, aliveSet.has(u) && pts === 0 ? 1 : 0);
        if (batch.length >= 1500) await flush();
      }
      await flush();
      span.setAttribute('players', players.length);
      span.setAttribute('answers', Object.keys(answers).length);
      this.lastScore = { correctCount, answered: Object.keys(answers).length, players: players.length };
    });
    m.scoring.observe(Number(process.hrtime.bigint() - started) / 1e9);

    const [distRaw, survivors] = await Promise.all([redis.hgetall(keys.dist(this.g, q)), redis.scard(keys.alive(this.g))]);
    const dist = question.options.map((_, i) => Number(distRaw[i] || 0));
    const endsAt = now() + config.revealSec * 1000;
    await this.publish(
      'reveal',
      { q, correct, correctText: question.options[correct], fact: question.fact, dist, answered: this.lastScore.answered, correctCount: this.lastScore.correctCount, players: this.lastScore.players, survivors },
      { phase: 'REVEAL', q, phaseEndsAt: endsAt },
    );
    this.at(endsAt, () => this.leaderboard(q));
  }

  async topPlayers(n) {
    const flat = await redis.zrevrange(keys.leaderboard(this.g), 0, n - 1, 'WITHSCORES');
    const ids = [];
    for (let i = 0; i < flat.length; i += 2) ids.push(flat[i]);
    const names = ids.length ? await redis.hmget(keys.names(this.g), ...ids) : [];
    const correct = ids.length ? await redis.hmget(keys.correct(this.g), ...ids) : [];
    return ids.map((id, i) => ({ id, name: names[i] || 'player', score: Number(flat[i * 2 + 1]), correct: Number(correct[i] || 0), rank: i + 1 }));
  }

  async leaderboard(q) {
    const endsAt = now() + config.leaderboardSec * 1000;
    const [top, survivors, players] = await Promise.all([this.topPlayers(10), redis.scard(keys.alive(this.g)), redis.scard(keys.players(this.g))]);
    const isLast = q + 1 >= this.questions.length;
    await this.publish('leaderboard', { q, top, survivors, players, isLast }, { phase: 'LEADERBOARD', q, phaseEndsAt: endsAt });
    this.at(endsAt, () => this.next(q));
  }

  async next(q) {
    if (q + 1 < this.questions.length) return this.openQuestion(q + 1);
    return this.finish();
  }

  async finish() {
    const [top, survivors, players] = await Promise.all([this.topPlayers(10), redis.scard(keys.alive(this.g)), redis.scard(keys.players(this.g))]);
    if (this.state.phase !== 'FINISHED') {
      await this.publish('finished', { top, survivors, players, total: this.questions.length }, { phase: 'FINISHED', phaseEndsAt: now() });
    }
    await this.saveResults(players, survivors);
    this.guard();
    // The game is over: remove it from etcd so no engine campaigns for it again, and let the live
    // Redis keys expire in an hour (history now lives in PostgreSQL).
    await this.elector.client.delete().key(`/buzzarena/games/${this.g}`);
    await this.expireKeys();
    await this.elector.resign(this.g, this.token);
    this.stop('finished');
  }

  async saveResults(playerCount, survivorCount) {
    const flat = await redis.zrevrange(keys.leaderboard(this.g), 0, -1, 'WITHSCORES');
    const ids = [];
    const scores = [];
    for (let i = 0; i < flat.length; i += 2) {
      ids.push(flat[i]);
      scores.push(Number(flat[i + 1]));
    }
    const [aliveList, correctMap] = await Promise.all([redis.smembers(keys.alive(this.g)), redis.hgetall(keys.correct(this.g))]);
    const alive = new Set(aliveList);
    await withTx(async (c) => {
      // Fenced on the database: only a leader whose token is at least the recorded one may finish the game.
      const g = await c.query(`SELECT status, leader_token FROM games WHERE id = $1 FOR UPDATE`, [this.g]);
      if (!g.rowCount || Number(g.rows[0].leader_token) > this.token) {
        m.fenced.labels('postgres').inc();
        throw new FencedError('postgres');
      }
      if (g.rows[0].status === 'FINISHED') return; // an earlier leader already saved them
      const ranks = ids.map((_, i) => i + 1);
      await c.query(
        `INSERT INTO game_results (game_id, user_id, score, rank, correct_count, survived)
         SELECT $1, u::uuid, s, r, cc, sv FROM unnest($2::text[], $3::int[], $4::int[], $5::int[], $6::bool[]) AS t(u, s, r, cc, sv)
         ON CONFLICT DO NOTHING`,
        [this.g, ids, scores, ranks, ids.map((u) => Number(correctMap[u] || 0)), ids.map((u) => alive.has(u))],
      );
      await c.query(
        `UPDATE games SET status = 'FINISHED', finished_at = now(), finished_by = $2, player_count = $3, survivor_count = $4 WHERE id = $1`,
        [this.g, this.engineId, playerCount, survivorCount],
      );
    });
    this.log.info({ players: playerCount, survivors: survivorCount }, 'final results saved');
  }

  async expireKeys() {
    const ks = [keys.gameState, keys.gameConfig, keys.fence, keys.seq, keys.log, keys.answers, keys.leaderboard, keys.players, keys.alive, keys.names, keys.correct].map((f) => f(this.g));
    for (let q = 0; q < this.questions.length; q++) ks.push(keys.answered(this.g, q), keys.dist(this.g, q), keys.points(this.g, q));
    const p = redis.pipeline();
    for (const k of ks) p.expire(k, 3600);
    await p.exec();
  }

  // ---------- the answer stream ----------

  /** Wait (up to 3 s) until every answer in the stream has been read and acknowledged. */
  async waitForStream() {
    const until = now() + 3000;
    while (now() < until) {
      const groups = await redis.xinfo('GROUPS', keys.answers(this.g)).catch(() => []);
      const g = groups.find((x) => x[1] === 'engine');
      if (!g) return;
      const info = Object.fromEntries(g.reduce((acc, v, i) => (i % 2 ? acc : [...acc, [v, g[i + 1]]]), []));
      if (Number(info.pending) === 0 && (info.lag === null || Number(info.lag) === 0)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async consumeLoop() {
    const stream = keys.answers(this.g);
    // First take over answers a previous leader read but never acknowledged (it crashed mid-batch).
    let cursor = '0-0';
    try {
      do {
        const [next, entries] = await this.stream.xautoclaim(stream, 'engine', this.engineId, 0, cursor, 'COUNT', 1000);
        if (entries.length) await this.processEntries(entries.filter(Boolean));
        cursor = next;
      } while (cursor !== '0-0' && this.running);
    } catch (err) {
      if (this.running) this.log.warn({ err: err.message }, 'xautoclaim failed');
    }

    while (this.running) {
      try {
        const res = await this.stream.xreadgroup('GROUP', 'engine', this.engineId, 'COUNT', 1000, 'BLOCK', 500, 'STREAMS', stream, '>');
        if (res && res[0][1].length) await this.processEntries(res[0][1]);
      } catch (err) {
        if (!this.running) return;
        this.log.warn({ err: err.message }, 'reading the answer stream failed, retrying');
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  async processEntries(entries) {
    const ids = [];
    const byQuestion = new Map();
    const traced_ = [];
    const results = { accepted: 0, duplicate: 0, late: 0, wrong_question: 0, not_player: 0, invalid: 0 };
    const phase = this.state.phase;
    const cur = Number(this.state.q);
    const openedAt = Number(this.state.openedAt);
    const deadline = Number(this.state.deadline);
    for (const [id, fields] of entries) {
      ids.push(id);
      const f = {};
      for (let i = 0; i < fields.length; i += 2) f[fields[i]] = fields[i + 1];
      const q = Number(f.q);
      const c = Number(f.c);
      const t = Number(f.t);
      if (f.tp) traced_.push(f);
      if (q !== cur || !['QUESTION', 'LOCKED'].includes(phase)) f.result = 'wrong_question';
      else if (t < openedAt || t > deadline + config.answerGraceMs) f.result = 'late';
      else if (!Number.isInteger(c) || c < 0 || c >= (this.questions[q]?.options.length || 0)) f.result = 'invalid';
      if (f.result) {
        results[f.result]++;
        continue;
      }
      if (!byQuestion.has(q)) byQuestion.set(q, { args: [], entries: [] });
      byQuestion.get(q).args.push(f.u, c, t);
      byQuestion.get(q).entries.push(f);
    }

    // For sampled answers, child spans show the two Redis calls (shared by the whole batch).
    let parents = [];
    const childSpans = (name, attrs) => parents.map((sp) => tracer().startSpan(name, { kind: SpanKind.CLIENT, attributes: { 'db.system': 'redis', ...attrs } }, trace.setSpan(context.active(), sp)));
    const endAll = (arr) => arr.forEach((x) => x.end());
    const work = async () => {
      for (const [q, batch] of byQuestion) {
        const cs = childSpans('redis EVAL recordAnswers', { 'db.operation': 'first answer wins (HSETNX) + count (HINCRBY)', 'batch.size': batch.entries.length });
        const out = await redis.recordAnswers(keys.answered(this.g, q), keys.dist(this.g, q), keys.players(this.g), ...batch.args);
        endAll(cs);
        out.forEach((r, i) => {
          const result = r === 1 ? 'accepted' : r === 0 ? 'duplicate' : 'not_player';
          batch.entries[i].result = result;
          results[result]++;
        });
      }
      const xs = childSpans('redis XACK', { 'db.operation': 'acknowledge the stream entries' });
      await this.stream.xack(keys.answers(this.g), 'engine', ...ids);
      endAll(xs);
    };

    if (traced_.length) {
      // Continue the trace each sampled answer started on the gateway: one child span per answer.
      const spans = (parents = traced_.map((f) =>
        tracer().startSpan('engine.record_answer', { kind: SpanKind.CONSUMER, attributes: { 'game.id': this.g, 'answer.user': f.u, 'question.index': Number(f.q), 'answer.choice': Number(f.c), 'batch.size': entries.length } }, contextFromTraceparent(f.tp)),
      ));
      try {
        await work();
      } finally {
        spans.forEach((sp, i) => {
          context.with(trace.setSpan(context.active(), sp), () =>
            this.log.info({ user: traced_[i].u, q: Number(traced_[i].q), result: traced_[i].result, msBeforeDeadline: Number(this.state.deadline) - Number(traced_[i].t) }, `answer ${traced_[i].result}`),
          );
          sp.setAttribute('answer.result', traced_[i].result || 'unknown');
          sp.setAttribute('answer.received_at', Number(traced_[i].t));
          sp.setAttribute('question.deadline', Number(this.state.deadline));
          sp.end();
        });
      }
    } else {
      await work();
    }
    for (const [k, v] of Object.entries(results)) if (v) m.answers.labels(k).inc(v);
    this.stats.processed += entries.length;
    this.stats.accepted += results.accepted;
  }

  snapshot() {
    return { gameId: this.g, title: this.cfg?.title, token: this.token, phase: this.state.phase, q: Number(this.state.q || 0), total: this.questions?.length, seq: Number(this.state.seq || 0) };
  }
}
