// A small client for BuzzArena, used by the tests, the demos, the bots and the load test.
// It talks to the system exactly like the web app does: HTTPS for the API, WSS for the game.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

// The dev certificate is self-signed: accept it (for local use only).
process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= '0';
process.removeAllListeners('warning');

export const BASE = process.env.BASE_URL || 'https://localhost:8443';
export const WS_URL = process.env.WS_URL || BASE.replace(/^http/, 'ws') + '/ws';
export const ORIGIN = process.env.ORIGIN || BASE;
export const LOADTEST_SECRET = process.env.LOADTEST_SECRET || 'change-me-loadtest-secret';

export async function api(method, path, { token, body, headers = {}, raw = false } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { text };
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status} ${json?.error?.code || ''} ${json?.error?.message || text.slice(0, 100)}`);
    err.status = res.status;
    err.body = json;
    err.headers = res.headers;
    throw err;
  }
  return Object.assign(json || {}, { _headers: res.headers });
}

export const ACCOUNTS = {
  admin: ['admin@buzzarena.dev', 'arena-admin-2026'],
  meera: ['meera@buzzarena.dev', 'host-meera-2026'],
  rohan: ['rohan@buzzarena.dev', 'host-rohan-2026'],
  asha: ['asha@buzzarena.dev', 'play-asha-2026'],
  kabir: ['kabir@buzzarena.dev', 'play-kabir-2026'],
  priya: ['priya@buzzarena.dev', 'play-priya-2026'],
  vikram: ['vikram@buzzarena.dev', 'play-vikram-2026'],
  zoya: ['zoya@buzzarena.dev', 'play-zoya-2026'],
};

export async function login(who) {
  const [email, password] = ACCOUNTS[who] || who;
  const r = await api('POST', '/api/auth/login', { body: { email, password } });
  return { token: r.accessToken, refreshToken: r.refreshToken, user: r.user };
}

/** Load-test bots: accounts + access tokens without password hashing (needs LOADTEST_MODE on the server). */
export async function botTokens(count, prefix = 'bot', start = 0) {
  const out = [];
  for (let i = 0; i < count; i += 2000) {
    const n = Math.min(2000, count - i);
    const r = await api('POST', '/api/auth/bot-tokens', { body: { count: n, prefix, start: start + i }, headers: { 'X-Loadtest-Secret': LOADTEST_SECRET } });
    out.push(...r.bots);
  }
  return out;
}

export async function createGame(hostToken, { title, packSlug = 'general', questionCount = 5, questionSec = 10 } = {}) {
  const { packs } = await api('GET', '/api/packs');
  const pack = packs.find((p) => p.slug === packSlug) || packs[0];
  const r = await api('POST', '/api/games', { token: hostToken, body: { title: title || `Test game ${Date.now() % 100000}`, packId: pack.id, questionCount, questionSec } });
  return r.game.id;
}

export const startGame = (hostToken, gameId) => api('POST', `/api/games/${gameId}/start`, { token: hostToken });

/** Correct answers for a game's questions (admin only). The load test uses it to make "smart" bots. */
export async function answerKey(adminToken, gameId, hostToken) {
  const host = await api('GET', `/api/games/${gameId}/host`, { token: hostToken || adminToken });
  const packs = (await api('GET', '/api/packs')).packs;
  const keyByText = new Map();
  for (const p of packs) {
    const qs = (await api('GET', `/api/packs/${p.id}/questions`, { token: adminToken })).questions;
    for (const q of qs) keyByText.set(q.text, q.correct);
  }
  return { keyByText, total: host.game.total };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One player on a WebSocket. Reconnects with exponential backoff + jitter and resumes from the last
 * sequence number it saw. Records everything the tests and demos check.
 */
export class Player extends EventEmitter {
  constructor({ token, name = 'player', gameId, answer = null, reconnect = true, wsUrl = WS_URL, origin = ORIGIN }) {
    super();
    Object.assign(this, { token, name, gameId, answerFn: answer, reconnect, wsUrl, origin });
    this.lastSeq = 0;
    this.seqs = [];
    this.gaps = 0;
    this.dupes = 0;
    this.acks = [];
    this.sentAt = new Map(); // question -> when this client sent its answer (for ack latency)
    this.ackMs = [];
    this.results = [];
    this.fanoutMs = [];
    this.reconnects = 0;
    this.reconnectMs = [];
    this.lostAt = null;
    this.gateways = [];
    this.closedByUs = false;
    this.phase = null;
    this.finished = null;
    this.joined = null;
  }

  async connect() {
    const { ticket } = await api('POST', '/api/auth/ws-ticket', { token: this.token });
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${this.wsUrl}?ticket=${ticket}`, { headers: { Origin: this.origin }, rejectUnauthorized: false, perMessageDeflate: false });
      this.ws = ws;
      let opened = false;
      ws.on('open', () => {
        opened = true;
        resolve();
      });
      ws.on('unexpected-response', (req, res) => {
        const err = new Error(`WebSocket refused: HTTP ${res.statusCode}`);
        err.status = res.statusCode;
        reject(err);
      });
      ws.on('error', (err) => {
        if (!opened) reject(err);
      });
      ws.on('message', (data) => this.onMessage(data));
      ws.on('close', (code) => this.onClose(code, opened));
    });
  }

  send(obj) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj));
    // Like the web app: an answer tapped while reconnecting is sent as soon as the connection is back.
    else if (obj.type === 'answer') this.outbox = [...(this.outbox || []), obj];
  }

  join(gameId = this.gameId) {
    this.gameId = gameId;
    this.send({ type: 'join', gameId, lastSeq: this.lastSeq });
  }

  onMessage(data) {
    const now = Date.now();
    const msg = JSON.parse(data);
    if (msg.seq) {
      if (msg.seq <= this.lastSeq) this.dupes++;
      else {
        if (this.lastSeq && msg.seq !== this.lastSeq + 1) this.gaps++;
        this.lastSeq = msg.seq;
        this.seqs.push(msg.seq);
      }
      if (msg.at && msg.type === 'question') this.fanoutMs.push(now - msg.at);
    }
    switch (msg.type) {
      case 'welcome':
        this.gateways.push(msg.gateway);
        break;
      case 'joined':
        this.joined = msg;
        if (this.lostAt) {
          this.reconnectMs.push(now - this.lostAt);
          this.lostAt = null;
        }
        break;
      case 'question':
        this.phase = 'QUESTION';
        this.currentQuestion = msg;
        if (this.answerFn) this.scheduleAnswer(msg);
        break;
      case 'answer_ack':
        this.acks.push(msg);
        if (this.sentAt.has(msg.q)) {
          this.ackMs.push(now - this.sentAt.get(msg.q));
          this.sentAt.delete(msg.q);
        }
        break;
      case 'you':
        this.results.push(msg);
        break;
      case 'finished':
        this.finished = msg;
        break;
      default:
    }
    this.emit('msg', msg);
    this.emit(msg.type, msg);
  }

  scheduleAnswer(q) {
    // Replayed questions whose deadline has passed are ignored.
    const decision = this.answerFn(q);
    if (!decision) return;
    const { choice, delayMs } = decision;
    const at = Math.min(q.deadline - 150, Date.now() + delayMs);
    if (at <= Date.now() - 50 && Date.now() > q.deadline) return;
    setTimeout(() => {
      this.sentAt.set(q.q, Date.now());
      this.send({ type: 'answer', gameId: this.gameId, q: q.q, choice });
    }, Math.max(0, at - Date.now()));
  }

  async onClose(code, opened) {
    this.emit('closed', code);
    if (!this.closedByUs && opened) this.lostAt = Date.now();
    if (this.closedByUs || !this.reconnect || !opened) return;
    // Reconnect with exponential backoff and jitter, so thousands of players do not all come back in the same millisecond.
    for (let attempt = 0; attempt < 12 && !this.closedByUs; attempt++) {
      const delay = Math.min(250 * 2 ** attempt, 5000);
      await sleep(delay / 2 + Math.random() * delay);
      try {
        await this.connect();
        this.reconnects++;
        this.join();
        for (const m of this.outbox || []) this.ws.send(JSON.stringify(m));
        this.outbox = [];
        this.emit('reconnected');
        return;
      } catch {
        /* try again */
      }
    }
  }

  close() {
    this.closedByUs = true;
    this.ws?.close();
  }

  waitFor(type, timeoutMs = 60_000, pred = () => true) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.off(type, h);
        reject(new Error(`timeout waiting for ${type}`));
      }, timeoutMs);
      const h = (m) => {
        if (!pred(m)) return;
        clearTimeout(t);
        this.off(type, h);
        resolve(m);
      };
      this.on(type, h);
    });
  }
}

/** Connect many players, `concurrency` at a time. */
export async function connectMany(players, { concurrency = 50, onProgress } = {}) {
  let i = 0;
  let done = 0;
  const failures = [];
  async function worker() {
    while (i < players.length) {
      const p = players[i++];
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await p.connect();
          p.join();
          break;
        } catch (err) {
          if (attempt === 4) failures.push(err.message);
          await sleep(200 * (attempt + 1));
        }
      }
      done++;
      onProgress?.(done);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return failures;
}

export const percentile = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

export { sleep };
