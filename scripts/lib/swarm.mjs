// A swarm of bot players for demos and load tests.
//
// Bots answer like people: most of them answer, late rather than early (most taps come in the last
// few seconds), and a "smart" share picks the right answer. The harness knows the right answers only
// because it asks the admin API for the question bank before the game; the game never tells clients.
import { botTokens, Player, connectMany, login, api } from './client.mjs';

export async function loadAnswerKey() {
  const admin = await login('admin');
  const { packs } = await api('GET', '/api/packs');
  const key = new Map();
  for (const p of packs) {
    const { questions } = await api('GET', `/api/packs/${p.id}/questions`, { token: admin.token });
    for (const q of questions) key.set(q.text, q.correct);
  }
  return key;
}

export function botBrain({ smart = 0.6, answerRate = 0.95, keyByText } = {}) {
  return (q) => {
    if (Math.random() > answerRate) return null;
    const correct = keyByText?.get(q.text);
    const choice = correct != null && Math.random() < smart ? correct : Math.floor(Math.random() * q.options.length);
    const delayMs = q.questionMs * 0.97 * (1 - Math.pow(Math.random(), 2.2));
    return { choice, delayMs };
  };
}

export async function swarm({ count, gameId, prefix = 'bot', start = 0, concurrency = 100, brain, onProgress, reconnect = true }) {
  const tokens = await botTokens(count, prefix, start);
  const players = tokens.map((t) => new Player({ token: t.accessToken, name: t.name, gameId, answer: brain, reconnect }));
  const failures = await connectMany(players, { concurrency, onProgress });
  return { players, failures };
}
