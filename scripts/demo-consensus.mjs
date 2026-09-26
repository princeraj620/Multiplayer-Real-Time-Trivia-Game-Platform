// Demo: consensus. What happens when etcd loses members?
//   npm run demo:consensus
//
// Part 1: one of three etcd members is down. 2 of 3 is still a majority, so a crashed leader is
//         replaced as usual.
// Part 2: two members are down. 1 of 3 is NOT a majority: etcd refuses every write. The leader cannot
//         renew its lease, so it stops (it cannot prove it is still the only leader). The game PAUSES
//         instead of risking two leaders (consistency over availability, as in Project 2's CAP demo).
//         When a member comes back, a leader is elected again and the game continues.
import { sleep, api, login, createGame } from './lib/client.mjs';
import { setupGame, overview, sum } from './lib/scenario.mjs';
import { ctl, serviceOf } from './lib/ctl.mjs';
import { say, step, explain, ok, bad, bold, red, green, yellow, dim } from './lib/say.mjs';

const BOTS = Number(process.env.BOTS || 200);
const members = async () => (await overview()).etcd.members;
const showMembers = async () => {
  const ms = await members();
  say(`etcd: ${ms.map((m) => `${m.host.replace('http://', '')} ${m.up ? (m.isLeader ? green('leader') : 'follower') : red('down')}`).join(', ')}`);
  return ms;
};

step('Setting up a game');
const { players, start } = await setupGame({ bots: BOTS, title: 'Consensus demo', questions: 6, questionSec: 10 });
const w = players[0];
const leaders = [];
w.on('leader', (m) => leaders.push(m));
await sleep(800);
await start();
await w.waitFor('question', 60_000, (m) => m.q === 0);
await showMembers();

step('Part 1: stop one etcd member (2 of 3 left)');
ctl('stop', 'etcd3');
await sleep(2500);
await showMembers();
const q1 = await w.waitFor('question', 60_000, (m) => m.q === 1);
await sleep(2000);
say(`Killing the game leader ${bold(q1.leader)}…`);
ctl('kill', serviceOf(q1.leader));
const took = await w.waitFor('leader', 30_000, (m) => m.engine !== q1.leader);
ok(`With 2 of 3 members, etcd still elected a new leader: ${bold(took.engine)} (token ${took.token}) after ${(took.silenceMs / 1000).toFixed(1)} s of silence`);
ctl('start', serviceOf(q1.leader));

step('Part 2: stop a second member (1 of 3 left: no majority)');
await w.waitFor('question', 60_000, (m) => m.q === 3);
await sleep(1500);
const lostAt = Date.now();
ctl('stop', 'etcd2');
say(`${red('Stopped etcd2.')} Only one member is left.`);
explain('The leader engine cannot renew its lease any more. Within about 4 seconds it stops itself: it can no longer prove it is the only leader.');
let lastMsgAt = Date.now();
w.on('msg', (m) => {
  if (m.seq) lastMsgAt = Date.now();
});
await sleep(9000);
const quiet = Date.now() - lastMsgAt;
const o = await overview();
const game = o.games[0];
say(`Engines with a healthy lease: ${o.engines.filter((e) => e.election?.healthy).length} of ${o.engines.length}. Game phase stuck at ${bold(game?.phase)} (Q${(game?.q ?? 0) + 1}); no game messages for ${bold((quiet / 1000).toFixed(1) + ' s')}.`);
const host = await login('meera');
const other = await createGame(host.token, { title: 'Needs etcd', questionCount: 2 });
const r = await api('POST', `/api/games/${other}/start`, { token: host.token }).catch((e) => e);
(r.status === 503 ? ok : bad)(`Starting another game is refused: ${r.status} ${r.body?.error?.code}`);
ok('The game paused instead of running with a leader nobody can verify (CP: consistency over availability).');

step('Bringing etcd2 back (2 of 3: majority again)');
ctl('start', 'etcd2');
const restoredAt = Date.now();
explain('The old leader key can only disappear once its lease expires, which etcd counts again from the moment it has a majority.');
const back = await w.waitFor('leader', 60_000, (m) => m.at > lostAt);
say(`${green('Leader again')}: ${bold(back.engine)} (token ${back.token}), ${((Date.now() - restoredAt) / 1000).toFixed(1)} s after the majority came back (${((Date.now() - lostAt) / 1000).toFixed(1)} s paused in total). It resumed from ${back.resumedPhase}.`);
await showMembers();
await api('POST', `/api/games/${other}/cancel`, { token: host.token }).catch(() => {});

await w.waitFor('finished', 240_000);
await sleep(1000);
step('Checking the game');
const gaps = sum(players.map((p) => p.gaps));
(gaps === 0 ? ok : bad)(`${players.length} players, ${gaps} missed messages`);
say(dim(`Leaders during this game: ${leaders.map((l) => `${l.engine} (token ${l.token})`).join(' → ')}`));
ctl('start', 'etcd3');
say('etcd3 restarted: 3 of 3 members.');
for (const p of players) p.close();
setTimeout(() => process.exit(0), 300);
