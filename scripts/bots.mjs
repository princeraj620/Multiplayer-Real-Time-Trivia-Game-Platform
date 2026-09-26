// Fill a game with bot players (needs LOADTEST_MODE; see .env.loadtest).
//   npm run bots -- 300                  300 bots join the next scheduled game
//   npm run bots -- 300 <gameId>         … or a specific game
//   npm run bots -- 300 --start          … and start it as the host (Meera)
// The bots stay until the game ends. Open the game in your browser at the same time and play along.
import { api, login, startGame, sleep } from './lib/client.mjs';
import { swarm, botBrain, loadAnswerKey } from './lib/swarm.mjs';
import { say, bold, dim } from './lib/say.mjs';

const args = process.argv.slice(2);
const count = Number(args.find((a) => /^\d+$/.test(a)) || 200);
let gameId = args.find((a) => /^[0-9a-f-]{36}$/.test(a));
const doStart = args.includes('--start');

if (!gameId) {
  const { games } = await api('GET', '/api/games');
  const next = games.find((g) => g.status === 'SCHEDULED');
  if (!next) {
    console.error('No scheduled game. Create one on the Host page, or pass a game id.');
    process.exit(1);
  }
  gameId = next.id;
  say(`Joining ${bold(next.title)} (${gameId})`);
}

const key = await loadAnswerKey();
const { players, failures } = await swarm({
  count,
  gameId,
  prefix: 'bot',
  brain: botBrain({ keyByText: key, smart: Number(process.env.SMART || 0.65) }),
  onProgress: (n) => n % 100 === 0 && process.stdout.write(dim(`  ${n} connected\r`)),
});
say(`${players.length - failures.length} bots are in the lobby${failures.length ? ` (${failures.length} failed to connect)` : ''}`);

if (doStart) {
  await sleep(1000);
  const host = await login('meera');
  await startGame(host.token, gameId).then(() => say('Started the game as Meera.')).catch((e) => say(`Could not start: ${e.message}`));
}

await players[0].waitFor('finished', 60 * 60_000);
say('The game is over. Bots leaving.');
for (const p of players) p.close();
setTimeout(() => process.exit(0), 300);
