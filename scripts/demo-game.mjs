// Demo: one whole game, narrated in the terminal.
//   npm run demo:game            (BOTS=1000 npm run demo:game)
import { sleep, percentile } from './lib/client.mjs';
import { setupGame, sum } from './lib/scenario.mjs';
import { say, step, bold, dim, green, red, cyan, magenta } from './lib/say.mjs';

const BOTS = Number(process.env.BOTS || 300);
const COLORS = [red, cyan, green, magenta];

step('A host creates a game and players join the lobby');
const { players, start } = await setupGame({ bots: BOTS, title: 'Terminal quiz night', pack: 'system-design', questions: 3, questionSec: 10 });
const w = players[0];

w.on('leader', (m) => say(`Leader: ${bold(m.engine)} (fencing token ${m.token}) won the etcd election for this game`));
w.on('countdown', (m) => say(`Countdown: ${m.players} players, first question in ${((m.startsAt - Date.now()) / 1000).toFixed(0)} s`));
w.on('question', (m) => {
  step(`Question ${m.q + 1} of ${m.total}: ${m.text}`);
  m.options.forEach((o, i) => console.log(`   ${COLORS[i](bold('ABCD'[i]))}  ${o}`));
  setTimeout(() => {
    const f = players.map((p) => p.fanoutMs[m.q]).filter((x) => x != null);
    say(dim(`reached all ${f.length} players in ${Math.max(...f)} ms (p50 ${percentile(f, 50)} ms)`));
  }, 400);
});
let lastTally = 0;
w.on('tally', (m) => {
  if (Date.now() - lastTally < 3000 || !w.currentQuestion) return;
  lastTally = Date.now();
  say(dim(`${m.answered} answered, ${Math.max(0, Math.round((w.currentQuestion.deadline - Date.now()) / 1000))} s left`));
});
w.on('reveal', (m) => {
  const total = sum(m.dist) || 1;
  say(`Time! Correct answer: ${green(bold('ABCD'[m.correct] + '  ' + m.correctText))}`);
  m.dist.forEach((n, i) => console.log(`   ${COLORS[i]('ABCD'[i])} ${COLORS[i]('█'.repeat(Math.round((n / total) * 40)))} ${n}${i === m.correct ? green(' ✓') : ''}`));
  say(`${m.correctCount} of ${m.players} right. ${bold(m.survivors)} still in.`);
  if (m.fact) say(dim(m.fact));
});
w.on('leaderboard', (m) => say(`Top 3: ${m.top.slice(0, 3).map((t, i) => `${i + 1}. ${t.name} ${bold(t.score)}`).join('   ')}`));

await sleep(1000);
await start();
await w.waitFor('finished', 180_000);
await sleep(500);
step('Final results');
const fin = w.finished;
fin.top.slice(0, 5).forEach((t) => console.log(`   ${String(t.rank).padStart(2)}. ${t.name.padEnd(12)} ${bold(String(t.score).padStart(5))}  ${dim(`${t.correct} right`)}`));
say(`${fin.survivors} of ${fin.players} answered every question right.`);
const all = players.flatMap((p) => p.fanoutMs);
say(dim(`Every question reached every player: p50 ${percentile(all, 50)} ms, p99 ${percentile(all, 99)} ms. Missed messages: ${sum(players.map((p) => p.gaps))}.`));
for (const p of players) p.close();
setTimeout(() => process.exit(0), 300);
