// Load test: a full game night with thousands of players on one machine.
//   docker compose --env-file .env.loadtest up -d
//   PLAYERS=5000 npm run load
//   PLAYERS=10000 QUESTIONS=6 KILL_LEADER_AT_Q=3 KILL_GATEWAY_AT_Q=5 npm run load    (with chaos)
//
// Every player is a real WebSocket client going through Nginx and TLS, exactly like a browser.
// Results are printed and saved to load-tests/results/.
import fs from 'node:fs';
import { login, createGame, startGame, api, sleep, percentile } from '../scripts/lib/client.mjs';
import { swarm, botBrain, loadAnswerKey } from '../scripts/lib/swarm.mjs';
import { ctl, serviceOf } from '../scripts/lib/ctl.mjs';
import { say, step, bold, dim, green, red } from '../scripts/lib/say.mjs';

const PLAYERS = Number(process.env.PLAYERS || 5000);
const QUESTIONS = Number(process.env.QUESTIONS || 6);
const QUESTION_SEC = Number(process.env.QUESTION_SEC || 10);
const KILL_LEADER_AT_Q = Number(process.env.KILL_LEADER_AT_Q || 0);
const KILL_GATEWAY_AT_Q = Number(process.env.KILL_GATEWAY_AT_Q || 0);
const pct = (a) => `${percentile(a, 50)} / ${percentile(a, 95)} / ${percentile(a, 99)} ms`;
const sum = (a) => a.reduce((x, y) => x + y, 0);

step(`Game night: ${PLAYERS.toLocaleString()} players, ${QUESTIONS} questions of ${QUESTION_SEC} s`);
const key = await loadAnswerKey();
const host = await login('meera');
const gameId = await createGame(host.token, { title: `Load test ${PLAYERS}`, packSlug: 'general', questionCount: QUESTIONS, questionSec: QUESTION_SEC });

const t0 = Date.now();
const { players, failures } = await swarm({
  count: PLAYERS,
  gameId,
  prefix: 'load',
  concurrency: 200,
  brain: botBrain({ keyByText: key, smart: 0.7, answerRate: 0.96 }),
  onProgress: (n) => n % 1000 === 0 && say(dim(`${n.toLocaleString()} connected`)),
});
const connectSec = (Date.now() - t0) / 1000;
say(`${bold(players.length - failures.length)} players connected in ${connectSec.toFixed(1)} s (${failures.length} failed)`);
await sleep(3000);

// Sample the dashboard data every second while the game runs.
const samples = [];
const sampler = setInterval(async () => {
  try {
    const o = await api('GET', '/api/ops/overview');
    samples.push({ at: Date.now(), gateways: o.gateways.map((g) => ({ id: g.instance, conns: g.connections, aps: g.answersPerSec, sent: g.sentPerSec, mem: g.memMb })), lag: o.engines.flatMap((e) => e.games.map((x) => x.lag)) });
  } catch {
    /* ignore */
  }
}, 1000);

const w = players[0];
const questionInfo = [];
const chaos = [];
w.on('question', (m) => questionInfo.push({ q: m.q, openedAt: m.openedAt, deadline: m.deadline, leader: m.leader }));
w.on('reveal', (m) => Object.assign(questionInfo.find((x) => x.q === m.q) || {}, { counted: m.answered, correctCount: m.correctCount, survivors: m.survivors, revealAt: Date.now() }));
w.on('question', async (m) => {
  if (KILL_LEADER_AT_Q && m.q === KILL_LEADER_AT_Q - 1) {
    await sleep(4000);
    chaos.push({ what: `kill leader ${m.leader}`, at: Date.now(), q: m.q });
    say(red(`CHAOS: killing the leader ${m.leader} during question ${m.q + 1}`));
    ctl('kill', serviceOf(m.leader));
    setTimeout(() => ctl('start', serviceOf(m.leader)), 15_000);
  }
  if (KILL_GATEWAY_AT_Q && m.q === KILL_GATEWAY_AT_Q - 1) {
    await sleep(3000);
    const o = await api('GET', '/api/ops/overview');
    const g = o.gateways.sort((a, b) => b.connections - a.connections)[0];
    chaos.push({ what: `kill ${g.instance} (${g.connections} sockets)`, at: Date.now(), q: m.q });
    say(red(`CHAOS: killing ${g.instance} with ${g.connections} players during question ${m.q + 1}`));
    ctl('kill', serviceOf(g.instance));
    setTimeout(() => ctl('start', serviceOf(g.instance)), 15_000);
  }
});

const started = Date.now();
await startGame(host.token, gameId);
say('Game started');
await w.waitFor('finished', (QUESTIONS * (QUESTION_SEC + 12) + 60) * 1000);
await sleep(3000);
clearInterval(sampler);
const gameSec = (Date.now() - started) / 1000;

step('Results');
const rows = [];
for (const qi of questionInfo) {
  const fan = players.map((p) => p.fanoutMs[qi.q]).filter((x) => x != null);
  const acks = players.flatMap((p) => p.acks.filter((a) => a.q === qi.q && a.status === 'RECEIVED'));
  const perSec = {};
  for (const a of acks) perSec[Math.floor((a.recvAt - qi.openedAt) / 1000)] = (perSec[Math.floor((a.recvAt - qi.openedAt) / 1000)] || 0) + 1;
  const lastThree = acks.filter((a) => qi.deadline - a.recvAt <= 3000).length;
  rows.push({
    q: qi.q + 1,
    reached: fan.length,
    fanout: { p50: percentile(fan, 50), p95: percentile(fan, 95), p99: percentile(fan, 99), max: Math.max(...fan) },
    answersAcked: acks.length,
    answersCounted: qi.counted,
    peakPerSec: Math.max(...Object.values(perSec)),
    lastThreeSecShare: acks.length ? Math.round((lastThree / acks.length) * 100) : 0,
    survivors: qi.survivors,
    revealAfterDeadlineMs: qi.revealAt ? qi.revealAt - qi.deadline : null,
    leader: qi.leader,
  });
}
console.table(rows.map((r) => ({ Q: r.q, reached: r.reached, 'fan-out p50/p95/p99 (ms)': `${r.fanout.p50}/${r.fanout.p95}/${r.fanout.p99}`, acked: r.answersAcked, counted: r.answersCounted, 'peak/s': r.peakPerSec, 'last 3 s': `${r.lastThreeSecShare}%`, 'still in': r.survivors, leader: r.leader })));

const allFan = players.flatMap((p) => p.fanoutMs);
const ackMs = players.flatMap((p) => p.ackMs);
const gaps = sum(players.map((p) => p.gaps));
const reconnects = sum(players.map((p) => p.reconnects));
const acked = sum(rows.map((r) => r.answersAcked));
const counted = sum(rows.map((r) => r.answersCounted || 0));
const finished = players.filter((p) => p.finished).length;
const res = await api('GET', `/api/games/${gameId}/results`);
const peakConns = Math.max(...samples.map((s) => sum(s.gateways.map((g) => g.conns))));
const peakAps = Math.max(...samples.map((s) => sum(s.gateways.map((g) => g.aps))));
const peakSent = Math.max(...samples.map((s) => sum(s.gateways.map((g) => g.sent))));
const maxLag = Math.max(0, ...samples.flatMap((s) => s.lag));
const mem = samples.length ? samples[samples.length - 1].gateways.map((g) => `${g.id} ${g.mem} MB`).join(', ') : '';

const summary = {
  players: PLAYERS,
  connectedIn: `${connectSec.toFixed(1)} s`,
  failedToConnect: failures.length,
  questions: QUESTIONS,
  questionFanout_p50_p95_p99: pct(allFan),
  answerAck_p50_p95_p99: pct(ackMs),
  answersAcked: acked,
  answersCounted: counted,
  answersLost: acked - counted,
  answerOutcomes: Object.entries(players.flatMap((p) => p.acks).reduce((a, x) => ((a[x.status] = (a[x.status] || 0) + 1), a), {})).map(([k, v]) => `${k} ${v}`).join(', '),
  peakAnswersPerSec: peakAps,
  peakMessagesOutPerSec: peakSent,
  peakConnections: peakConns,
  maxStreamLag: maxLag,
  missedMessages: gaps,
  reconnects,
  reconnectTime_p50_p95_max: (() => {
    const r = players.flatMap((p) => p.reconnectMs);
    return r.length ? `${percentile(r, 50)} / ${percentile(r, 95)} / ${Math.max(...r)} ms` : '–';
  })(),
  sawFinalResults: finished,
  resultsSavedFor: res.game.player_count,
  gameDurationSec: Math.round(gameSec),
  gatewayMemory: mem,
  chaos: chaos.map((c) => `${c.what} in Q${c.q + 1}`),
};
console.log();
for (const [k, v] of Object.entries(summary)) console.log(`  ${k.padEnd(28)} ${bold(Array.isArray(v) ? v.join('; ') || '–' : v)}`);
console.log();
console.log(summary.answersLost === 0 && gaps === 0 ? green('  ✓ every acknowledged answer was counted and nobody missed a message') : red('  ✗ something was lost; see above'));

fs.mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
const file = new URL(`./results/game-night-${PLAYERS}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url);
fs.writeFileSync(file, JSON.stringify({ summary, rows, samples }, null, 2));
say(dim(`saved ${file.pathname}`));
for (const p of players) p.close();
setTimeout(() => process.exit(0), 500);
