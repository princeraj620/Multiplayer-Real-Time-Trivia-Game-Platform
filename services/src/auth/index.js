// Auth service: sign-up, login, refresh-token rotation, WebSocket tickets, and the public keys.
import * as jose from 'jose';
import crypto from 'node:crypto';
import { hash, verify, Algorithm } from '@node-rs/argon2';
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { query, withTx } from '../shared/db.js';
import { redis, keys as rkeys, createRedis } from '../shared/redis.js';
import { createApp, finishApp, ah, rateLimit, listen } from '../shared/http.js';
import { badRequest, unauthorized, forbidden, AppError, conflict } from '../shared/errors.js';
import { sha256, randomToken } from '../shared/crypto.js';
import { counter } from '../shared/metrics.js';
import { startOpsReporter } from '../shared/ops.js';
import { verifyAccessToken } from '../shared/auth.js';
import { loadKeys, rotateKey, getJwks, getActive } from './keys.js';

const ARGON = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }; // OWASP minimum
const COOKIE = 'ba_refresh';

const mLogins = counter('buzz_auth_logins_total', 'Login attempts', ['result']);
const mRefresh = counter('buzz_auth_refresh_total', 'Refresh attempts', ['result']);
const mReuse = counter('buzz_auth_refresh_reuse_detected_total', 'A used refresh token was presented again (theft)');
const mTickets = counter('buzz_auth_ws_tickets_total', 'WebSocket tickets issued');
const stats = { logins: 0, failedLogins: 0, refreshes: 0, reuseDetected: 0, tickets: 0 };

let DUMMY_HASH = null; // verify against this when the email is unknown, so timing does not reveal accounts

async function issueAccessToken(user) {
  const { kid, privateKey } = getActive();
  return new jose.SignJWT({ name: user.name, role: user.role })
    .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'JWT' })
    .setSubject(user.id)
    .setIssuer(config.jwtIssuer)
    .setAudience(config.jwtAudience)
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime(`${config.accessTokenTtlSec}s`)
    .sign(privateKey);
}

async function issueRefreshToken(client, userId, familyId, userAgent) {
  const token = randomToken(32);
  await client.query(
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4), $5)`,
    [userId, familyId, sha256(token), config.refreshTokenTtlSec, (userAgent || '').slice(0, 200)],
  );
  return token;
}

function setRefreshCookie(res, token) {
  const parts = [`${COOKIE}=${token}`, 'HttpOnly', 'SameSite=Strict', 'Path=/api/auth', `Max-Age=${config.refreshTokenTtlSec}`];
  if (config.cookieSecure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearRefreshCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/api/auth; Max-Age=0${config.cookieSecure ? '; Secure' : ''}`);
}
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

async function audit(actorId, action, target, detail = {}) {
  await query(`INSERT INTO audit_log (actor_id, action, target, detail) VALUES ($1, $2, $3, $4)`, [actorId, action, target, detail]).catch(() => {});
}

const FIRST = ['Aarav', 'Ishaan', 'Diya', 'Kavya', 'Rohit', 'Sneha', 'Arjun', 'Meher', 'Nikhil', 'Tara', 'Aditya', 'Pooja', 'Farhan', 'Ananya', 'Karan', 'Riya', 'Vivek', 'Nisha', 'Siddharth', 'Lakshmi', 'Omar', 'Emma', 'Liam', 'Sofia', 'Noah', 'Mia', 'Lucas', 'Chen', 'Yuki', 'Amara', 'Mateo', 'Leila', 'Tomas', 'Hana', 'Kofi', 'Zara', 'Ravi', 'Neha', 'Dev', 'Isha', 'Manav', 'Anjali', 'Yash', 'Tanvi', 'Harsh', 'Divya', 'Kabir', 'Sana', 'Rahul', 'Aisha'];
const LAST = 'ABCDEFGHIJKLMNOPRSTVWYZ';
const botName = (i) => `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}.`;

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role });

async function sessionResponse(res, user, familyId, userAgent) {
  const refresh = await withTx((c) => issueRefreshToken(c, user.id, familyId || crypto.randomUUID(), userAgent));
  setRefreshCookie(res, refresh);
  const accessToken = await issueAccessToken(user);
  return { accessToken, expiresIn: config.accessTokenTtlSec, refreshToken: refresh, user: publicUser(user) };
}

const bearer = (req) => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
};

export async function start() {
  await loadKeys();
  DUMMY_HASH = await hash(randomToken(16), ARGON);
  setInterval(() => loadKeys().catch((e) => logger.warn({ err: e.message }, 'key reload failed')), 30_000).unref();
  const sub = createRedis('keys-sub');
  sub.subscribe('auth:keys-rotated');
  sub.on('message', () => loadKeys().catch(() => {}));

  const app = createApp({
    health: async () => ({
      postgres: await query('SELECT 1').then(() => 'ok').catch(() => 'down'),
      redis: await redis.ping().then(() => 'ok').catch(() => 'down'),
      signingKey: getActive() ? 'ok' : 'missing',
    }),
  });
  const r = (path) => `/api/auth${path}`;

  app.get(r('/.well-known/jwks.json'), (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(getJwks());
  });

  const perIp = rateLimit('login-ip', config.loginBurst * 3, config.loginPerSec * 3, (req) => req.ip);

  app.post(r('/signup'), perIp, ah(async (req, res) => {
    const { email, name, password } = req.body || {};
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('A valid email is needed');
    if (!name || String(name).trim().length < 2 || String(name).length > 40) throw badRequest('Name must be 2-40 characters');
    if (!password || String(password).length < 8) throw badRequest('Password must be at least 8 characters');
    const passwordHash = await hash(String(password), ARGON);
    const ins = await query(
      `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id, email, name, role`,
      [String(email).trim(), String(name).trim(), passwordHash],
    );
    if (!ins.rowCount) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
    mLogins.labels('signup').inc();
    res.status(201).json(await sessionResponse(res, ins.rows[0], null, req.headers['user-agent']));
  }));

  app.post(
    r('/login'),
    perIp,
    rateLimit('login-email', config.loginBurst, config.loginPerSec, (req) => String(req.body?.email || '').toLowerCase()),
    ah(async (req, res) => {
      const { email, password } = req.body || {};
      if (!email || !password) throw badRequest('Email and password are needed');
      const u = (await query(`SELECT id, email, name, role, password_hash FROM users WHERE lower(email) = lower($1)`, [email])).rows[0];
      const ok = await verify(u?.password_hash || DUMMY_HASH, String(password)).catch(() => false);
      if (!u || !u.password_hash || !ok) {
        mLogins.labels('failed').inc();
        stats.failedLogins++;
        logger.info({ email: String(email).replace(/(.).*@/, '$1***@') }, 'login failed');
        throw unauthorized('Wrong email or password');
      }
      mLogins.labels('ok').inc();
      stats.logins++;
      res.json(await sessionResponse(res, u, null, req.headers['user-agent']));
    }),
  );

  // Refresh-token rotation with reuse detection.
  app.post(r('/refresh'), perIp, ah(async (req, res) => {
    const origin = req.headers.origin;
    const fromCookie = readCookie(req, COOKIE);
    if (fromCookie && origin && !config.allowedOrigins.includes(origin)) throw forbidden('Origin not allowed', 'BAD_ORIGIN');
    const token = fromCookie || req.body?.refreshToken;
    if (!token) throw unauthorized('No refresh token');
    const out = await withTx(async (c) => {
      const row = (await c.query(
        `SELECT t.id, t.family_id, t.status, t.expires_at < now() AS expired, u.id AS uid, u.email, u.name, u.role
           FROM refresh_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1 FOR UPDATE OF t`,
        [sha256(token)],
      )).rows[0];
      if (!row) return { error: 'unknown' };
      if (row.status === 'USED') {
        // Someone presented a token that was already exchanged: the token was copied. Kill the family.
        await c.query(`UPDATE refresh_tokens SET status = 'REVOKED' WHERE family_id = $1 AND status <> 'REVOKED'`, [row.family_id]);
        return { error: 'reuse', userId: row.uid, familyId: row.family_id };
      }
      if (row.status === 'REVOKED' || row.expired) return { error: 'revoked' };
      await c.query(`UPDATE refresh_tokens SET status = 'USED', used_at = now() WHERE id = $1`, [row.id]);
      const next = await issueRefreshToken(c, row.uid, row.family_id, req.headers['user-agent']);
      return { user: { id: row.uid, email: row.email, name: row.name, role: row.role }, refresh: next };
    });
    if (out.error === 'reuse') {
      mReuse.inc();
      stats.reuseDetected++;
      mRefresh.labels('reuse_detected').inc();
      logger.warn({ userId: out.userId, familyId: out.familyId }, 'refresh token reuse detected: session family revoked');
      await audit(out.userId, 'refresh_token_reuse', out.familyId, { ip: req.ip });
      clearRefreshCookie(res);
      throw new AppError(401, 'TOKEN_REUSED', 'This refresh token was already used. All sessions from that login were signed out.');
    }
    if (out.error) {
      mRefresh.labels(out.error).inc();
      clearRefreshCookie(res);
      throw unauthorized('Session expired, please sign in again');
    }
    mRefresh.labels('ok').inc();
    stats.refreshes++;
    setRefreshCookie(res, out.refresh);
    res.json({ accessToken: await issueAccessToken(out.user), expiresIn: config.accessTokenTtlSec, refreshToken: out.refresh, user: publicUser(out.user) });
  }));

  app.post(r('/logout'), ah(async (req, res) => {
    const token = readCookie(req, COOKIE) || req.body?.refreshToken;
    if (token) {
      await query(
        `UPDATE refresh_tokens SET status = 'REVOKED' WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)`,
        [sha256(token)],
      );
    }
    clearRefreshCookie(res);
    res.status(204).end();
  }));

  app.get(r('/me'), ah(async (req, res) => {
    const user = await verifyAccessToken(bearer(req));
    res.json({ user });
  }));

  // A one-time, 30-second ticket to open a WebSocket. The access token never goes into a URL
  // (URLs end up in logs); the ticket is useless after one use or 30 s.
  app.post(r('/ws-ticket'), ah(async (req, res) => {
    const user = await verifyAccessToken(bearer(req));
    const ticket = randomToken(24);
    await redis.set(rkeys.wsTicket(ticket), JSON.stringify({ id: user.id, name: user.name, role: user.role }), 'EX', config.wsTicketTtlSec);
    mTickets.inc();
    stats.tickets++;
    res.json({ ticket, expiresIn: config.wsTicketTtlSec });
  }));

  app.post(r('/keys/rotate'), ah(async (req, res) => {
    const user = await verifyAccessToken(bearer(req));
    if (user.role !== 'admin') throw forbidden('Only admins can rotate keys', 'ROLE_REQUIRED');
    const kid = await rotateKey();
    await redis.publish('auth:keys-rotated', kid);
    await audit(user.id, 'signing_key_rotated', kid);
    logger.info({ kid, by: user.id }, 'signing key rotated');
    res.json({ kid, jwks: getJwks() });
  }));

  // Load tests only (LOADTEST_MODE=true + secret): create bot accounts and hand out access tokens
  // without password hashing, so 10,000 bots do not spend minutes in argon2.
  app.post(r('/bot-tokens'), ah(async (req, res) => {
    if (!config.loadtestMode || !config.loadtestSecret || req.headers['x-loadtest-secret'] !== config.loadtestSecret) {
      throw new AppError(404, 'NOT_FOUND', 'No such endpoint');
    }
    const count = Math.min(Number(req.body?.count) || 100, 5000);
    const prefix = String(req.body?.prefix || 'bot').replace(/[^a-z0-9-]/gi, '').slice(0, 20);
    const start = Number(req.body?.start) || 0;
    const handles = Array.from({ length: count }, (_, i) => `${prefix}-${String(start + i).padStart(5, '0')}`);
    // Display names look like people ("Ishaan R.") so screens and demos read naturally.
    const names = handles.map((_, i) => botName(start + i));
    const rows = (await query(
      `INSERT INTO users (email, name, is_bot)
         SELECT h || '@bots.buzzarena.dev', n, true FROM unnest($1::text[], $2::text[]) AS t(h, n)
       ON CONFLICT (lower(email)) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, name, role`,
      [handles, names],
    )).rows;
    const tokens = await Promise.all(rows.map(async (u) => ({ id: u.id, name: u.name, accessToken: await issueAccessToken(u) })));
    res.json({ bots: tokens });
  }));

  finishApp(app);
  const server = await listen(app, config.port);
  const ops = startOpsReporter(async () => ({ ...stats, kid: getActive()?.kid }));
  return async () => {
    clearInterval(ops);
    server.close();
  };
}
