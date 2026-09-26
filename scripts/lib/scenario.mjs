// Shared setup for the demos: a host creates a game, bots (or the demo accounts) join, the host starts it.
import { login, createGame, startGame, Player, connectMany, api } from './client.mjs';
import { swarm, botBrain, loadAnswerKey } from './swarm.mjs';
import { say, dim } from './say.mjs';

export async function setupGame({ bots = 300, title, pack = 'system-design', questions = 5, questionSec = 10, smart = 0.65, prefix = 'demo' } = {}) {
  const host = await login('meera');
  const gameId = await createGame(host.token, { title, packSlug: pack, questionCount: questions, questionSec });
  const key = await loadAnswerKey();
  const brain = botBrain({ keyByText: key, smart });
  let players;
  try {
    ({ players } = await swarm({ count: bots, gameId, prefix, brain }));
    say(`${players.length} bot players joined the lobby ${dim('(bot accounts need LOADTEST_MODE, see .env.loadtest)')}`);
  } catch (err) {
    if (err.status !== 404) throw err;
    say(dim('Bot accounts are disabled (LOADTEST_MODE=false): playing with the 5 demo accounts instead.'));
    const people = await Promise.all(['asha', 'kabir', 'priya', 'vikram', 'zoya'].map(login));
    players = people.map((p) => new Player({ token: p.token, name: p.user.name, gameId, answer: brain }));
    await connectMany(players);
  }
  return { host, gameId, players, key, start: () => startGame(host.token, gameId) };
}

export async function overview() {
  return api('GET', '/api/ops/overview');
}

export const sum = (arr) => arr.reduce((a, b) => a + b, 0);
export const countBy = (arr, fn) => arr.reduce((acc, x) => ((acc[fn(x)] = (acc[fn(x)] || 0) + 1), acc), {});
