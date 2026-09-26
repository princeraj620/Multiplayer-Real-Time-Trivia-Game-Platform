// Demo: attack the system and watch each defence work.
//   npm run demo:security
import * as jose from 'jose';
import WebSocket from 'ws';
import { api, login, createGame, startGame, Player, sleep, BASE, WS_URL, ORIGIN } from './lib/client.mjs';
import { say, step, explain, ok, bad, bold, cyan, dim } from './lib/say.mjs';

const check = (cond, text) => (cond ? ok(text) : bad(text));
const statusOf = async (p) => p.then(() => 200, (e) => e.status);
const wsStatus = (url, origin = ORIGIN) =>
  new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { Origin: origin }, rejectUnauthorized: false });
    ws.on('open', () => (ws.close(), resolve(101)));
    ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
    ws.on('error', () => resolve(0));
  });

const [asha, meera, rohan, admin] = await Promise.all(['asha', 'meera', 'rohan', 'admin'].map(login));

step('Encryption in transit');
const plain = await fetch(BASE.replace('https', 'http').replace('8443', '8080') + '/api/games', { redirect: 'manual' });
check(plain.status === 301, `Plain HTTP is redirected to HTTPS (${plain.status} → ${plain.headers.get('location')})`);
const h = (await fetch(BASE + '/')).headers;
check(!!h.get('strict-transport-security'), `HSTS: ${h.get('strict-transport-security')}`);
check(/default-src 'self'/.test(h.get('content-security-policy') || ''), 'Content-Security-Policy: scripts, styles and fonts only from this site; WebSocket only to this host');

step('Passwords and sign-in');
const t = async (email) => {
  const s = performance.now();
  await api('POST', '/api/auth/login', { body: { email, password: 'wrong-password' } }).catch(() => {});
  return performance.now() - s;
};
const known = await t('kabir@buzzarena.dev');
const unknown = await t('nobody-here@buzzarena.dev');
check(Math.abs(known - unknown) < 60, `A wrong password takes ${known.toFixed(0)} ms for a real account and ${unknown.toFixed(0)} ms for an unknown one: the timing does not reveal who has an account (argon2id runs either way)`);
let limitedAt = null;
for (let i = 1; i <= 14; i++) {
  const r = await api('POST', '/api/auth/login', { body: { email: 'priya@buzzarena.dev', password: `guess-${i}` } }).catch((e) => e);
  if (r.status === 429) {
    limitedAt = i;
    break;
  }
}
check(limitedAt !== null, `Password guessing on one account is stopped after ${limitedAt - 1} tries (429, token bucket per email)`);

step('Tokens');
const { privateKey } = await jose.generateKeyPair('EdDSA', { crv: 'Ed25519' });
const forged = await new jose.SignJWT({ name: 'Mallory', role: 'admin' }).setProtectedHeader({ alg: 'EdDSA', kid: 'fake' }).setSubject(asha.user.id).setIssuer('buzzarena-auth').setAudience('buzzarena').setExpirationTime('5m').sign(privateKey);
check((await statusOf(api('GET', '/api/admin/users', { token: forged }))) === 401, 'A token signed with an attacker\'s own key: 401 (only keys from our JWKS are trusted)');
const [hd, pl, sg] = asha.token.split('.');
const tampered = [hd, Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(pl, 'base64url')), role: 'admin' })).toString('base64url'), sg].join('.');
check((await statusOf(api('GET', '/api/admin/users', { token: tampered }))) === 401, 'Asha\'s real token with "role":"admin" edited in: 401 (the signature no longer matches)');
const none = [Buffer.from('{"alg":"none"}').toString('base64url'), pl, ''].join('.');
check((await statusOf(api('GET', '/api/admin/users', { token: none }))) === 401, 'An unsigned token (alg "none"): 401');

const s = await login('vikram');
const r1 = await api('POST', '/api/auth/refresh', { body: { refreshToken: s.refreshToken } });
const reuse = await api('POST', '/api/auth/refresh', { body: { refreshToken: s.refreshToken } }).catch((e) => e);
check(reuse.body?.error?.code === 'TOKEN_REUSED', 'Refresh token used twice (stolen copy): 401 TOKEN_REUSED');
check((await statusOf(api('POST', '/api/auth/refresh', { body: { refreshToken: r1.refreshToken } }))) === 401, 'and the newer token from that login is revoked too, so the thief and the victim both sign in again');

step('Who may do what (role-based access control)');
const packs = (await api('GET', '/api/packs')).packs;
const e1 = await api('POST', '/api/games', { token: asha.token, body: { title: 'Mine', packId: packs[0].id } }).catch((e) => e);
check(e1.status === 403, `A player creates a game: ${e1.status} ${e1.body?.error?.code}`);
const gid = await createGame(meera.token, { title: 'Meera\'s game', questionCount: 2, questionSec: 5 });
const e2 = await startGame(rohan.token, gid).catch((e) => e);
check(e2.status === 403, `Host Rohan starts host Meera's game: ${e2.status} ${e2.body?.error?.code}`);
check((await statusOf(api('GET', `/api/games/${gid}/host`, { token: asha.token }))) === 403, 'A player opens the host console (which shows the answers): 403');
check((await statusOf(api('GET', '/api/admin/users', { token: meera.token }))) === 403, 'A host opens the admin pages: 403');

step('WebSockets');
check((await wsStatus(WS_URL)) === 401, 'Connect without a ticket: 401');
const { ticket } = await api('POST', '/api/auth/ws-ticket', { token: asha.token });
check((await wsStatus(`${WS_URL}?ticket=${ticket}`, 'https://evil.example')) === 403, 'Connect from another website (Origin: https://evil.example): 403 (cross-site WebSocket hijacking)');
check((await wsStatus(`${WS_URL}?ticket=${ticket}`)) === 101, 'Connect with the ticket: 101 Switching Protocols');
check((await wsStatus(`${WS_URL}?ticket=${ticket}`)) === 401, 'Replay the same ticket: 401 (tickets work once, for 30 s)');

step('Cheating during a game');
const p = new Player({ token: asha.token, name: 'Asha', gameId: gid });
const frames = [];
p.on('msg', (m) => frames.push(m));
await p.connect();
p.join();
await sleep(500);
await startGame(meera.token, gid);
const q = await p.waitFor('question', 30_000);
const raw = JSON.stringify(q);
say(`The question frame every player receives: ${dim(raw.slice(0, 170) + '…')}`);
check(!('correct' in q), 'It has no "correct" field: the answer is not on any player\'s device before the deadline');
p.send({ type: 'answer', gameId: gid, q: q.q + 1, choice: 0 });
check((await p.waitFor('answer_ack')).status === 'NOT_OPEN', 'Answering the next question before it opens: NOT_OPEN');
p.send({ type: 'answer', gameId: gid, q: q.q, choice: 2 });
await p.waitFor('answer_ack');
p.send({ type: 'answer', gameId: gid, q: q.q, choice: 1 });
const dup = await p.waitFor('answer_ack');
check(dup.status === 'ALREADY_ANSWERED', `Changing the answer: ALREADY_ANSWERED (first answer wins, kept: ${'ABCD'[dup.choice]})`);
for (let i = 0; i < 8; i++) p.send({ type: 'answer', gameId: gid, q: q.q, choice: i % 4 });
await sleep(500);
check(p.acks.some((a) => a.status === 'RATE_LIMITED'), 'Flooding answers: RATE_LIMITED after a small burst');
const reveal = await p.waitFor('reveal', 30_000);
check(Number.isInteger(reveal.correct), `The answer (${'ABCD'[reveal.correct]}) is only sent in the reveal, after the deadline`);
p.send({ type: 'answer', gameId: gid, q: q.q, choice: reveal.correct });
check(['TOO_LATE', 'NOT_OPEN'].includes((await p.waitFor('answer_ack')).status), 'Answering after seeing the reveal: TOO_LATE');
p.close();

step('Encryption at rest and the audit log');
const { questions } = await api('GET', `/api/packs/${packs[0].id}/questions`, { token: admin.token });
say(`In the database, the answer to "${questions[0].text}" is stored as ${cyan(questions[0].ciphertext)}`);
check(questions[0].ciphertext.startsWith(questions[0].keyId + ':'), `AES-256-GCM with key "${questions[0].keyId}", bound to the question id (a copied ciphertext does not decrypt on another row)`);
const audit = (await api('GET', '/api/admin/audit', { token: admin.token })).audit;
check(audit.some((a) => a.action === 'refresh_token_reuse'), 'The stolen refresh token is in the security audit log (and the RefreshTokenReuse alert fires in Prometheus)');
setTimeout(() => process.exit(0), 200);
