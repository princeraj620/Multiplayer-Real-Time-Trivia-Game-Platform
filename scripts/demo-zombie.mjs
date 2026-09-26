// Demo: the "zombie leader". A leader freezes (a long GC pause, a VM stall, a laptop lid closed),
// loses its lease, a new leader takes over, and then the old one wakes up still believing it leads.
//   npm run demo:zombie
//
// Two lines of defence stop it from corrupting the game:
//   1. self-fencing: it notices its lease was not renewed and stops before writing, and
//   2. the fencing token: if it writes anyway, Redis (and PostgreSQL) reject its older token.
// Start the engines with SELF_FENCING=false to switch off (1) and watch (2) do the job.
import { sleep } from './lib/client.mjs';
import { setupGame, overview, sum } from './lib/scenario.mjs';
import { ctl, serviceOf } from './lib/ctl.mjs';
import { say, step, explain, ok, bad, bold, red, green, yellow, dim } from './lib/say.mjs';

const BOTS = Number(process.env.BOTS || 200);

step('Setting up a game');
const { players, start } = await setupGame({ bots: BOTS, title: 'Zombie leader demo', questions: 4, questionSec: 10 });
const watcher = players[0];
const seen = [];
watcher.on('msg', (m) => m.seq && seen.push({ seq: m.seq, token: m.token, type: m.type, at: Date.now() }));
await sleep(800);
await start();
const q = await watcher.waitFor('question', 60_000, (m) => m.q === 1);
const victim = q.leader;
const oldToken = q.token;
say(`Question 2 is open. Leader: ${bold(victim)}, fencing token ${bold(oldToken)}`);
await sleep(2000);

step(`Freezing ${victim} (it is paused, not killed: its memory and timers survive)`);
ctl('pause', serviceOf(victim));
const frozeAt = Date.now();
say(`${yellow('PAUSED')} ${victim}. It cannot renew its etcd lease any more.`);
const took = await watcher.waitFor('leader', 30_000, (m) => m.engine !== victim);
say(`${green('New leader')}: ${bold(took.engine)}, token ${bold(took.token)}, after ${((Date.now() - frozeAt) / 1000).toFixed(1)} s`);

await sleep(3000);
step(`Waking ${victim} up. It still thinks it leads with token ${oldToken}.`);
ctl('unpause', serviceOf(victim));
const wokeAt = Date.now();
explain('Its overdue timers fire at once: it tries to publish the next step of question 2 and to write its heartbeat.');
await sleep(3000);

const o = await overview();
const zombie = o.engines.find((e) => e.instance === victim);
const events = (zombie?.recent || []).filter((e) => e.at >= wokeAt - 500);
const reasons = events.map((e) => e.reason).filter(Boolean);
const byToken = events.find((e) => e.type === 'stepped-down' && String(e.reason).startsWith('fenced by'));
const bySelf = events.find((e) => e.reason === 'self-fenced' || e.type === 'lease-lost');
if (byToken && (!bySelf || byToken.at <= bySelf.at)) {
  ok(`${victim} tried to write with token ${oldToken}; ${byToken.reason.replace('fenced by ', '').replace('redis', 'Redis').replace('postgres', 'PostgreSQL')} already had the newer token ${took.token} and ${bold('rejected the write')}. It stepped down.`);
} else if (bySelf) {
  ok(`${victim} noticed its lease had not been renewed and stopped ${bold('before writing anything')} (self-fencing).`);
  explain('Start the engines with SELF_FENCING=false to watch the fencing token catch it instead.');
} else {
  say(dim(`events from ${victim}: ${JSON.stringify(events)}`));
}
if (reasons.length) say(dim(`  ${victim} said: ${reasons.join('; ')}`));

await watcher.waitFor('finished', 180_000);
await sleep(1000);

step('Checking the game');
const after = seen.filter((m) => m.at > wokeAt);
const stale = after.filter((m) => m.token && m.token < took.token);
(stale.length === 0 ? ok : bad)(`${after.length} messages after the zombie woke up, ${stale.length} carried the old token`);
const gaps = sum(players.map((p) => p.gaps));
(gaps === 0 ? ok : bad)(`${players.length} players, ${gaps} missed or out-of-order messages`);
const tokens = [...new Set(seen.map((m) => m.token).filter(Boolean))];
say(dim(`Fencing tokens seen by players, in order: ${tokens.join(' → ')} (they only ever go up)`));
for (const p of players) p.close();
setTimeout(() => process.exit(0), 300);
