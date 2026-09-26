// Demo: a WebSocket gateway dies with thousands of players on it.
//   npm run demo:gateway            (BOTS=3000 npm run demo:gateway for more)
//
// What to watch: players on the dead gateway reconnect (with backoff + jitter, so they do not all
// arrive in the same millisecond), land on the other gateways, and resume from the last message
// they saw. Nobody misses a question, and answers already sent still count.
import { sleep, percentile } from './lib/client.mjs';
import { setupGame, overview, sum, countBy } from './lib/scenario.mjs';
import { ctl, serviceOf } from './lib/ctl.mjs';
import { say, step, explain, ok, bad, bold, red, green, dim } from './lib/say.mjs';

const BOTS = Number(process.env.BOTS || 1500);

step('Setting up a game');
const { players, start } = await setupGame({ bots: BOTS, title: 'Gateway crash demo', questions: 4, questionSec: 10 });
await sleep(1500);
const before = await overview();
say(`Players per gateway: ${before.gateways.map((g) => `${g.instance} ${bold(g.connections)}`).join(', ')}`);
await start();
const watcherAll = players;
await players[0].waitFor('question', 60_000, (m) => m.q === 1);
await sleep(3000);

step('Killing the busiest gateway in the middle of question 2');
const o = await overview();
const victim = o.gateways.sort((a, b) => b.connections - a.connections)[0];
const onVictim = players.filter((p) => p.gateways[p.gateways.length - 1] === victim.instance);
const killedAt = Date.now();
ctl('kill', serviceOf(victim.instance));
say(`${red('KILL -9')} ${bold(victim.instance)} with ${bold(victim.connections)} players connected`);
explain('Each client sees its socket close, waits 125-375 ms (random), and reconnects through Nginx, which skips the dead gateway.');

await sleep(8000);
const moved = onVictim.filter((p) => p.reconnects > 0);
const times = moved.flatMap((p) => p.reconnectMs);
say(`${green(moved.length)} of ${onVictim.length} players reconnected. Time back in the game: p50 ${percentile(times, 50)} ms, p95 ${percentile(times, 95)} ms, max ${Math.max(...times)} ms`);
const landed = countBy(moved, (p) => p.gateways[p.gateways.length - 1]);
explain(`All ${moved.length} reconnect at once from this ONE Node process, so its TLS handshakes queue up on the CPU; one player alone is back in about 0.2 s.`);
say(`Where they went: ${Object.entries(landed).map(([g, n]) => `${g} ${bold(n)}`).join(', ')}`);

await watcherAll[0].waitFor('finished', 180_000);
await sleep(1500);

step('Checking the game');
const gaps = sum(players.map((p) => p.gaps));
(gaps === 0 ? ok : bad)(`${players.length} players, ${gaps} missed messages (the moved players got the messages sent while they were away replayed from the room log)`);
const replayedResumes = moved.filter((p) => p.joined?.resumed).length;
(replayedResumes === moved.length ? ok : bad)(`${replayedResumes} of ${moved.length} moved players resumed from their last sequence number`);
const q2before = onVictim.flatMap((p) => p.acks.filter((a) => a.q === 1 && a.status === 'RECEIVED' && a.recvAt < killedAt));
const q2counted = q2before.filter((a) => onVictim.some((p) => p.results.some((r) => r.after === 'reveal' && r.q === 1 && r.choice != null && p.acks.includes(a))));
(q2counted.length === q2before.length ? ok : bad)(`${q2before.length} answers were sent to the dead gateway before it died; ${q2counted.length} counted (they were already in the Redis Stream)`);
const finished = players.filter((p) => p.finished).length;
(finished === players.length ? ok : bad)(`${finished} of ${players.length} players saw the final results`);

step(`Restarting ${victim.instance}`);
ctl('start', serviceOf(victim.instance));
say('New players will be balanced onto it again (least connections).');
for (const p of players) p.close();
setTimeout(() => process.exit(0), 300);
