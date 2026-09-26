// Demo: the game leader crashes in the middle of a question.
//   npm run demo:failover            (BOTS=500 npm run demo:failover for more players)
//
// What to watch: the question stays open with its ORIGINAL deadline, answers sent while there is no
// leader are kept in the Redis Stream, and a new leader (with a bigger fencing token) finishes the job.
import { sleep, api, percentile } from './lib/client.mjs';
import { setupGame, sum } from './lib/scenario.mjs';
import { ctl, serviceOf } from './lib/ctl.mjs';
import { say, step, explain, ok, bad, bold, yellow, red, green, cyan, dim } from './lib/say.mjs';

const BOTS = Number(process.env.BOTS || 500);
const KILL_AT_Q = Number(process.env.KILL_AT_Q || 2); // 1-based question number
const KILL_AFTER_MS = Number(process.env.KILL_AFTER_MS || 4000);

step('Setting up a game');
const { gameId, players, start } = await setupGame({ bots: BOTS, title: 'Failover demo', questions: 4, questionSec: 10 });
const watcher = players[0];
const timeline = [];
watcher.on('msg', (m) => {
  if (['question', 'locked', 'reveal', 'leader'].includes(m.type)) timeline.push({ at: Date.now(), ...m });
});

await sleep(1000);
await start();
say('Host pressed Start.');
const first = await watcher.waitFor('leader', 20_000);
say(`Leader elected through etcd: ${bold(first.engine)} with fencing token ${bold(first.token)}`);

const q = await watcher.waitFor('question', 120_000, (m) => m.q === KILL_AT_Q - 1);
const deadline = q.deadline;
say(`Question ${KILL_AT_Q} is open: "${q.text}" (deadline in ${((deadline - Date.now()) / 1000).toFixed(1)} s)`);
await sleep(KILL_AFTER_MS);

step(`Crashing the leader in the middle of question ${KILL_AT_Q}`);
const victim = q.leader;
const killedAt = Date.now();
ctl('kill', serviceOf(victim));
say(`${red('KILL -9')} ${bold(victim)} (${((deadline - killedAt) / 1000).toFixed(1)} s left on the clock)`);
explain('No engine is leading this game now. Players keep answering; the gateways keep putting answers into the Redis Stream.');

const took = await watcher.waitFor('leader', 30_000, (m) => m.engine !== victim);
const tookAt = Date.now();
say(`${green('New leader')}: ${bold(took.engine)} with fencing token ${bold(took.token)} (was ${first.token})`);
say(`It read the checkpoint (phase ${took.resumedPhase}) and continued. Leader silence: ${bold((took.silenceMs / 1000).toFixed(1) + ' s')}`);

const reveal = await watcher.waitFor('reveal', 30_000, (m) => m.q === KILL_AT_Q - 1);
say(`Question ${KILL_AT_Q} was revealed ${((reveal.at - deadline) / 1000).toFixed(2)} s after its original deadline: answer ${bold('ABCD'[reveal.correct])}, ${reveal.answered} answers counted`);

await watcher.waitFor('finished', 180_000);
await sleep(2000);

step('Checking what the players saw');
const questionMsgs = timeline.filter((m) => m.type === 'question' && m.q === KILL_AT_Q - 1);
const reopened = questionMsgs.length !== 1 || questionMsgs[0].deadline !== deadline;
reopened ? bad('The question was restarted') : ok(`Question ${KILL_AT_Q} was sent once and kept its original deadline (not restarted)`);

const duringOutage = players.flatMap((p) => p.acks.filter((a) => a.q === KILL_AT_Q - 1 && a.status === 'RECEIVED' && a.recvAt >= killedAt && a.recvAt <= tookAt).map((a) => ({ p, a })));
const scored = duringOutage.filter(({ p }) => p.results.some((r) => r.after === 'reveal' && r.q === KILL_AT_Q - 1 && r.choice != null));
(scored.length === duringOutage.length ? ok : bad)(`${duringOutage.length} answers arrived while there was NO leader; ${scored.length} of them were counted`);

const totalAcked = sum(players.map((p) => p.acks.filter((a) => a.status === 'RECEIVED').length));
const gaps = sum(players.map((p) => p.gaps));
(gaps === 0 ? ok : bad)(`${players.length} players, ${totalAcked.toLocaleString()} answers accepted, ${gaps} missed messages`);

const res = await api('GET', `/api/games/${gameId}/results`);
(res.game.status === 'FINISHED' ? ok : bad)(`Final results saved by ${res.game.finished_by} for ${res.game.player_count} players (read from the ${res._headers.get('x-read-from') || 'replica'})`);

const fan = players.flatMap((p) => p.fanoutMs);
say(dim(`Question fan-out to ${players.length} players: p50 ${percentile(fan, 50)} ms, p95 ${percentile(fan, 95)} ms, p99 ${percentile(fan, 99)} ms`));

step('Restarting the crashed engine');
ctl('start', serviceOf(victim));
say(`${victim} is back as a standby. It will lead the next game that needs a leader.`);
for (const p of players) p.close();
setTimeout(() => process.exit(0), 300);
