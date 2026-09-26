// The game connection in the browser.
//
// - Authenticates with a one-time ticket (never puts the access token in a URL).
// - Remembers the last sequence number; after a reconnect it asks the gateway to replay from there.
// - Reconnects with exponential backoff + jitter, so 17,000 players whose gateway died do not all
//   hit the next one in the same millisecond.
// - Syncs its clock with the server (NTP-style): the countdown uses SERVER time, so every player
//   sees the same deadline no matter how wrong their phone clock is.
import { wsTicket } from './api.js';

export class GameSocket {
  constructor(onMessage, onStatus) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.gameId = null;
    this.lastSeq = 0;
    this.offset = 0; // serverTime - localTime
    this.rtt = null;
    this.status = 'idle';
    this.gateway = null;
    this.reconnects = 0;
    this.log = [];
    this.stopped = false;
    this.bestRtt = Infinity;
  }

  now() {
    return Date.now() + this.offset;
  }

  setStatus(s) {
    this.status = s;
    this.onStatus?.(this);
  }

  async start(gameId) {
    this.gameId = gameId;
    this.stopped = false;
    await this.open();
  }

  async open() {
    this.setStatus(this.reconnects ? 'reconnecting' : 'connecting');
    const { ticket } = await wsTicket();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?ticket=${encodeURIComponent(ticket)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.setStatus('open');
      this.bestRtt = Infinity;
      for (let i = 0; i < 5; i++) setTimeout(() => this.ping(), i * 200);
      this.pinger = setInterval(() => this.ping(), 15_000);
      ws.send(JSON.stringify({ type: 'join', gameId: this.gameId, lastSeq: this.lastSeq }));
      if (this.pending) {
        ws.send(JSON.stringify(this.pending));
        this.pending = null;
      }
    };
    ws.onmessage = (ev) => this.handle(JSON.parse(ev.data));
    ws.onclose = (ev) => {
      clearInterval(this.pinger);
      if (this.stopped || this.ws !== ws) return;
      this.setStatus('reconnecting');
      this.retry(ev.code);
    };
  }

  async retry() {
    for (let attempt = 0; !this.stopped; attempt++) {
      const delay = Math.min(300 * 2 ** attempt, 8000);
      await new Promise((r) => setTimeout(r, delay / 2 + Math.random() * delay));
      if (this.stopped) return;
      try {
        this.reconnects++;
        await this.open();
        return;
      } catch {
        /* try again */
      }
    }
  }

  ping() {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'ping', t0: Date.now() }));
  }

  handle(msg) {
    if (msg.type === 'pong') {
      const t1 = Date.now();
      const rtt = t1 - msg.t0;
      // Keep the sample with the smallest round trip: it has the least network noise.
      if (rtt <= this.bestRtt) {
        this.bestRtt = rtt;
        this.offset = msg.serverTime - (msg.t0 + rtt / 2);
      }
      this.rtt = rtt;
      this.onStatus?.(this);
      return;
    }
    if (msg.type === 'welcome') this.gateway = msg.gateway;
    if (msg.seq) {
      if (msg.seq <= this.lastSeq) return; // already seen (a replay overlapping live messages)
      this.lastSeq = msg.seq;
    }
    if (msg.type !== 'tally' && msg.type !== 'presence') {
      this.log.unshift({ seq: msg.seq || '', type: msg.type, at: Date.now(), detail: summary(msg) });
      if (this.log.length > 40) this.log.pop();
    }
    this.onMessage(msg);
  }

  send(obj) {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  answer(q, choice) {
    const msg = { type: 'answer', gameId: this.gameId, q, choice };
    if (this.send(msg)) return true;
    // Reconnecting: keep the answer and send it right after the next join (the gateway stamps the
    // time it arrives, so it still has to arrive before the deadline).
    this.pending = msg;
    return true;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.pinger);
    this.ws?.close();
  }
}

function summary(m) {
  switch (m.type) {
    case 'question':
      return `Q${m.q + 1} open`;
    case 'reveal':
      return `answer ${'ABCD'[m.correct]}`;
    case 'leader':
      return `${m.engine}, token ${m.token}`;
    case 'answer_ack':
      return `${m.status}`;
    case 'you':
      return m.points != null ? `+${m.points} pts` : `rank ${m.rank ?? '-'}`;
    case 'joined':
      return m.resumed ? `resumed after #${m.fromSeq}` : m.spectator ? 'watching' : 'playing';
    case 'welcome':
      return m.gateway;
    default:
      return '';
  }
}
