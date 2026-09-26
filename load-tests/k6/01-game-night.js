// k6 version of the game-night load test (runs inside Docker, nothing to install):
//   docker compose --env-file .env.loadtest up -d
//   docker compose --profile loadtest run --rm -e PLAYERS=2000 k6 run /scripts/01-game-night.js
//
// setup() signs in the host, creates a game and bot accounts; each virtual user is one player on a
// WebSocket; one extra virtual user (the host) starts the game once everyone has joined.
import http from 'k6/http';
import ws from 'k6/ws';
import { check } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'https://localhost:8443';
const ORIGIN = __ENV.ORIGIN || BASE;
const WS = BASE.replace('https', 'wss') + '/ws';
const PLAYERS = Number(__ENV.PLAYERS || 1000);
const QUESTIONS = Number(__ENV.QUESTIONS || 5);
const JOIN_SECONDS = Number(__ENV.JOIN_SECONDS || Math.max(20, PLAYERS / 100));

const fanout = new Trend('question_fanout_ms', true);
const ackTime = new Trend('answer_ack_ms', true);
const answers = new Counter('answers_received');
const lateAnswers = new Counter('answers_too_late');
const gaps = new Counter('missed_messages');

export const options = {
  insecureSkipTLSVerify: true,
  setupTimeout: '120s',
  scenarios: {
    players: { executor: 'per-vu-iterations', exec: 'player', vus: PLAYERS, iterations: 1, maxDuration: '15m' },
    host: { executor: 'per-vu-iterations', exec: 'host', vus: 1, iterations: 1, startTime: `${JOIN_SECONDS}s`, maxDuration: '1m' },
  },
  thresholds: {
    missed_messages: ['count==0'],
    question_fanout_ms: ['p(95)<1000'],
  },
};

const json = (body, token, extra = {}) => ({ headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra } });

export function setup() {
  const host = http.post(`${BASE}/api/auth/login`, JSON.stringify({ email: 'meera@buzzarena.dev', password: 'host-meera-2026' }), json()).json();
  const packs = http.get(`${BASE}/api/packs`, json()).json().packs;
  const game = http.post(`${BASE}/api/games`, JSON.stringify({ title: `k6 game night (${PLAYERS})`, packId: packs[0].id, questionCount: QUESTIONS, questionSec: 10 }), json(null, host.accessToken)).json().game;
  const tokens = [];
  for (let i = 0; i < PLAYERS; i += 2000) {
    const r = http.post(`${BASE}/api/auth/bot-tokens`, JSON.stringify({ count: Math.min(2000, PLAYERS - i), prefix: 'k6', start: i }), json(null, null, { 'X-Loadtest-Secret': __ENV.LOADTEST_SECRET || '' }));
    check(r, { 'bot accounts created (LOADTEST_MODE on?)': (x) => x.status === 200 });
    tokens.push(...r.json().bots.map((b) => b.accessToken));
  }
  return { gameId: game.id, hostToken: host.accessToken, tokens };
}

export function host(data) {
  const r = http.post(`${BASE}/api/games/${data.gameId}/start`, null, json(null, data.hostToken));
  check(r, { 'game started': (x) => x.status === 200 });
}

export function player(data) {
  const token = data.tokens[__VU - 1];
  const ticket = http.post(`${BASE}/api/auth/ws-ticket`, null, json(null, token)).json().ticket;
  let lastSeq = 0;
  const sentAt = {};
  const res = ws.connect(`${WS}?ticket=${ticket}`, { headers: { Origin: ORIGIN } }, (socket) => {
    socket.on('open', () => socket.send(JSON.stringify({ type: 'join', gameId: data.gameId, lastSeq: 0 })));
    socket.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.seq) {
        if (lastSeq && m.seq !== lastSeq + 1 && m.seq > lastSeq) gaps.add(1);
        if (m.seq > lastSeq) lastSeq = m.seq;
      }
      if (m.type === 'question') {
        fanout.add(Date.now() - m.at);
        if (Math.random() < 0.95) {
          const delay = m.questionMs * 0.95 * (1 - Math.pow(Math.random(), 2.2));
          socket.setTimeout(() => {
            sentAt[m.q] = Date.now();
            socket.send(JSON.stringify({ type: 'answer', gameId: data.gameId, q: m.q, choice: Math.floor(Math.random() * m.options.length) }));
          }, delay);
        }
      } else if (m.type === 'answer_ack') {
        if (m.status === 'RECEIVED') {
          answers.add(1);
          if (sentAt[m.q]) ackTime.add(Date.now() - sentAt[m.q]);
        } else if (m.status === 'TOO_LATE') lateAnswers.add(1);
      } else if (m.type === 'finished') {
        socket.setTimeout(() => socket.close(), 1000);
      }
    });
    socket.setTimeout(() => socket.close(), 14 * 60 * 1000);
  });
  check(res, { 'WebSocket upgraded (101)': (r) => r && r.status === 101 });
}
