// End-to-end tests against the running system (https://localhost:8443 by default).
//   npm test
// Games in these tests use 5-second questions, so the whole file takes about two minutes.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as jose from 'jose';
import WebSocket from 'ws';
import { api, login, createGame, startGame, Player, sleep, BASE, WS_URL, ORIGIN } from '../scripts/lib/client.mjs';

let meera, rohan, asha, kabir, priya, admin;

before(async () => {
  [meera, rohan, asha, kabir, priya, admin] = await Promise.all(['meera', 'rohan', 'asha', 'kabir', 'priya', 'admin'].map(login));
});

const status = async (p) => {
  try {
    await p;
    return 200;
  } catch (err) {
    return err.status;
  }
};

async function wsAttempt(url, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { Origin: ORIGIN, ...headers }, rejectUnauthorized: false });
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
    ws.on('error', () => resolve(0));
  });
}

test('HTTP redirects to HTTPS, and HTTPS responses carry security headers', async () => {
  const http = BASE.replace('https://', 'http://').replace(':8443', ':8080');
  const r = await fetch(http + '/', { redirect: 'manual' });
  assert.equal(r.status, 301);
  assert.match(r.headers.get('location'), /^https:\/\//);
  const s = await fetch(BASE + '/');
  assert.match(s.headers.get('strict-transport-security') || '', /max-age=/);
  assert.match(s.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.equal(s.headers.get('x-frame-options'), 'DENY');
});

test('login: wrong password is refused; the token verifies against the published keys', async () => {
  assert.equal(await status(api('POST', '/api/auth/login', { body: { email: 'asha@buzzarena.dev', password: 'nope-nope' } })), 401);
  const { keys } = await api('GET', '/api/auth/.well-known/jwks.json');
  const jwks = { keys };
  assert.ok(jwks.keys.length >= 1);
  const { payload, protectedHeader } = await jose.jwtVerify(asha.token, jose.createLocalJWKSet(jwks), { issuer: 'buzzarena-auth', audience: 'buzzarena' });
  assert.equal(protectedHeader.alg, 'EdDSA');
  assert.equal(payload.role, 'player');
  assert.ok(payload.exp - payload.iat <= 900, 'access tokens are short-lived');
});

test('forged tokens are rejected (own key, alg none, tampered role)', async () => {
  const { privateKey } = await jose.generateKeyPair('EdDSA', { crv: 'Ed25519' });
  const forged = await new jose.SignJWT({ name: 'Mallory', role: 'admin' }).setProtectedHeader({ alg: 'EdDSA', kid: 'fake' }).setSubject(asha.user.id).setIssuer('buzzarena-auth').setAudience('buzzarena').setExpirationTime('10m').sign(privateKey);
  assert.equal(await status(api('GET', '/api/admin/users', { token: forged })), 401);
  const none = [Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify({ sub: asha.user.id, role: 'admin', iss: 'buzzarena-auth', aud: 'buzzarena', exp: 9999999999 })).toString('base64url'), ''].join('.');
  assert.equal(await status(api('GET', '/api/admin/users', { token: none })), 401);
  const [h, p, sig] = asha.token.split('.');
  const tampered = [h, Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), role: 'admin' })).toString('base64url'), sig].join('.');
  assert.equal(await status(api('GET', '/api/admin/users', { token: tampered })), 401);
});

test('refresh tokens rotate, and reusing an old one revokes the whole session family', async () => {
  const s = await login('zoya');
  const r1 = await api('POST', '/api/auth/refresh', { body: { refreshToken: s.refreshToken } });
  assert.notEqual(r1.refreshToken, s.refreshToken);
  // Someone replays the first (already used) refresh token: theft detected.
  const reuse = await api('POST', '/api/auth/refresh', { body: { refreshToken: s.refreshToken } }).catch((e) => e);
  assert.equal(reuse.status, 401);
  assert.equal(reuse.body.error.code, 'TOKEN_REUSED');
  // The legitimate newer token was revoked too (the attacker might have it).
  assert.equal(await status(api('POST', '/api/auth/refresh', { body: { refreshToken: r1.refreshToken } })), 401);
});

test('role-based access: players cannot host, hosts cannot touch other hosts\' games or admin pages', async () => {
  const packs = (await api('GET', '/api/packs')).packs;
  const r = await api('POST', '/api/games', { token: asha.token, body: { title: 'Nope', packId: packs[0].id } }).catch((e) => e);
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'ROLE_REQUIRED');
  const gameId = await createGame(meera.token, { title: 'Meera only', questionCount: 2, questionSec: 5 });
  const s = await startGame(rohan.token, gameId).catch((e) => e);
  assert.equal(s.status, 403);
  assert.equal(s.body.error.code, 'NOT_YOUR_GAME');
  assert.equal(await status(api('GET', `/api/games/${gameId}/host`, { token: asha.token })), 403);
  assert.equal(await status(api('GET', '/api/admin/users', { token: meera.token })), 403);
  assert.equal(await status(api('GET', '/api/admin/users', { token: admin.token })), 200);
  await api('POST', `/api/games/${gameId}/cancel`, { token: meera.token });
});

test('WebSocket needs a one-time ticket and an allowed Origin', async () => {
  assert.equal(await wsAttempt(WS_URL), 401);
  assert.equal(await wsAttempt(`${WS_URL}?ticket=made-up`), 401);
  const { ticket } = await api('POST', '/api/auth/ws-ticket', { token: asha.token });
  assert.equal(await wsAttempt(`${WS_URL}?ticket=${ticket}`, { Origin: 'https://evil.example' }), 403);
  const { ticket: t2 } = await api('POST', '/api/auth/ws-ticket', { token: asha.token });
  assert.equal(await wsAttempt(`${WS_URL}?ticket=${t2}`), 101);
  assert.equal(await wsAttempt(`${WS_URL}?ticket=${t2}`), 401, 'a ticket works only once');
});

test('the correct answer is stored encrypted and only admins can read the key', async () => {
  const packs = (await api('GET', '/api/packs')).packs;
  const { questions } = await api('GET', `/api/packs/${packs[0].id}/questions`, { token: admin.token });
  assert.match(questions[0].ciphertext, /^k\d+:/);
  assert.equal(await status(api('GET', `/api/packs/${packs[0].id}/questions`, { token: meera.token })), 403);
});

test('a full game: same messages for everyone, no gaps, no early answers, results saved', { timeout: 120_000 }, async () => {
  const gameId = await createGame(meera.token, { title: 'E2E full game', packSlug: 'general', questionCount: 2, questionSec: 5 });
  const frames = [];
  const mk = (s, choice) => new Player({ token: s.token, name: s.user.name, gameId, answer: () => ({ choice, delayMs: 800 }) });
  const [pa, pk, pp] = [mk(asha, 0), mk(kabir, 1), mk(priya, 2)];
  pa.on('msg', (m) => frames.push(m));
  for (const p of [pa, pk, pp]) {
    await p.connect();
    p.join();
  }
  if (!pa.joined) await pa.waitFor('joined');
  await sleep(500);
  await startGame(meera.token, gameId);
  await pa.waitFor('question', 20_000);
  // A spectator: joins after the start and cannot answer.
  const late = new Player({ token: (await login('vikram')).token, name: 'Vikram', gameId });
  await late.connect();
  late.join();
  const j = await late.waitFor('joined');
  assert.equal(j.spectator, true);
  late.send({ type: 'answer', gameId, q: 0, choice: 0 });
  assert.equal((await late.waitFor('answer_ack')).status, 'SPECTATOR');

  // Answer twice: the second is refused.
  await pa.waitFor('answer_ack', 10_000);
  pa.send({ type: 'answer', gameId, q: 0, choice: 3 });
  const second = await pa.waitFor('answer_ack', 5000);
  assert.equal(second.status, 'ALREADY_ANSWERED');
  assert.equal(second.choice, 0);

  await pa.waitFor('finished', 90_000);
  await pk.waitFor('finished', 5000).catch(() => {});
  for (const p of [pa, pk, pp]) {
    assert.equal(p.gaps, 0, `${p.name} missed messages`);
    assert.equal(p.dupes, 0);
  }
  assert.deepEqual(pk.seqs, pa.seqs, 'every player got the same sequence of messages');
  // No question message ever contained the answer; every reveal did.
  const questions = frames.filter((m) => m.type === 'question');
  assert.equal(questions.length, 2);
  for (const q of questions) {
    assert.equal(q.correct, undefined);
    assert.equal(JSON.stringify(q).includes('"correct"'), false);
  }
  assert.equal(frames.filter((m) => m.type === 'reveal' && Number.isInteger(m.correct)).length, 2);
  // Late answer after the deadline.
  pa.send({ type: 'answer', gameId, q: 1, choice: 0 });
  const lateAck = await pa.waitFor('answer_ack', 5000);
  assert.ok(['TOO_LATE', 'NOT_OPEN'].includes(lateAck.status));

  await sleep(1500);
  const res = await api('GET', `/api/games/${gameId}/results`);
  assert.equal(res.game.status, 'FINISHED');
  assert.equal(res.top.length, 3);
  const hist = await api('GET', '/api/me/history', { token: asha.token });
  assert.ok(hist.history.some((h) => h.id === gameId));
  for (const p of [pa, pk, pp, late]) p.close();
});

test('reconnect and resume: a dropped player gets every message it missed', { timeout: 120_000 }, async () => {
  const gameId = await createGame(meera.token, { title: 'E2E resume', questionCount: 2, questionSec: 5 });
  const p = new Player({ token: asha.token, name: 'Asha', gameId, answer: () => ({ choice: 1, delayMs: 500 }) });
  await p.connect();
  p.join();
  await p.waitFor('joined');
  await startGame(meera.token, gameId);
  await p.waitFor('question', 20_000);
  // Cut the connection (as if the phone went through a tunnel); the client reconnects with lastSeq.
  p.ws.terminate();
  const joined = await p.waitFor('joined', 20_000);
  assert.equal(joined.resumed, true);
  await p.waitFor('finished', 90_000);
  assert.equal(p.gaps, 0);
  assert.ok(p.reconnects >= 1);
  p.close();
});

test('answer spam is rate-limited per connection', { timeout: 90_000 }, async () => {
  const gameId = await createGame(meera.token, { title: 'E2E spam', questionCount: 2, questionSec: 5 });
  const p = new Player({ token: kabir.token, name: 'Kabir', gameId });
  await p.connect();
  p.join();
  await p.waitFor('joined');
  await startGame(meera.token, gameId);
  const q = await p.waitFor('question', 20_000);
  for (let i = 0; i < 12; i++) p.send({ type: 'answer', gameId, q: q.q, choice: i % 4 });
  await sleep(1500);
  const statuses = p.acks.map((a) => a.status);
  assert.equal(statuses.filter((s) => s === 'RECEIVED').length, 1);
  assert.ok(statuses.includes('RATE_LIMITED'));
  p.close();
});

test('the dashboard sees one etcd leader key per live game and a healthy Raft cluster', async () => {
  const o = await api('GET', '/api/ops/overview');
  assert.ok(o.etcd.members.filter((m) => m.up).length >= 2);
  assert.equal(o.etcd.members.filter((m) => m.isLeader).length, 1);
  const leaders = o.etcd.leaders || [];
  assert.equal(new Set(leaders.map((l) => l.gameId)).size, leaders.length, 'never two leaders for one game');
  assert.ok(o.engines.length >= 1 && o.gateways.length >= 1);
});

test('sign-up creates a player account; the same email cannot sign up twice', async () => {
  const email = `newbie-${Date.now()}@example.com`;
  const r = await api('POST', '/api/auth/signup', { body: { name: 'Newbie', email, password: 'correct-horse-battery' } });
  assert.equal(r.user.role, 'player');
  assert.ok(r.accessToken);
  const again = await api('POST', '/api/auth/signup', { body: { name: 'Copy', email, password: 'correct-horse-battery' } }).catch((e) => e);
  assert.equal(again.status, 409);
  const weak = await api('POST', '/api/auth/signup', { body: { name: 'Weak', email: `w-${email}`, password: 'short' } }).catch((e) => e);
  assert.equal(weak.status, 400);
});

test('rotating the signing key: new tokens use the new key, tokens signed before still work', async () => {
  const before = await login('kabir');
  const r = await api('POST', '/api/auth/keys/rotate', { token: admin.token });
  assert.ok(r.jwks.keys.length >= 2, 'the old public key stays published');
  await sleep(1500);
  const after = await login('kabir');
  const kid = (t) => JSON.parse(Buffer.from(t.split('.')[0], 'base64url')).kid;
  assert.equal(kid(after.token), r.kid);
  assert.notEqual(kid(before.token), r.kid);
  assert.equal(await status(api('GET', '/api/me/history', { token: before.token })), 200, 'old token still valid');
  assert.equal(await status(api('GET', '/api/me/history', { token: after.token })), 200, 'new token accepted after the key refresh');
});
