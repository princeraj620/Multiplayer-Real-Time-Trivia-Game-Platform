// Verifying access tokens (used by the lobby API and the WebSocket gateways).
//
// Tokens are signed by the auth service with an Ed25519 private key. Everyone else only needs the
// PUBLIC keys, published at /api/auth/.well-known/jwks.json. They are fetched once, cached, and
// refreshed every 5 minutes or when an unknown key id shows up (key rotation). So if the auth service
// is down, running services keep verifying tokens with the keys they already have.
import * as jose from 'jose';
import { config } from './config.js';
import { logger } from './logger.js';
import { unauthorized, forbidden } from './errors.js';

let jwks = null;
let localSet = null;
let lastFetch = 0;
let fetching = null;

async function fetchJwks() {
  if (fetching) return fetching;
  fetching = (async () => {
    try {
      // AUTH_JWKS_URL may list several auth instances; the first one that answers wins.
      let lastErr;
      for (const url of config.authJwksUrl.split(',')) {
        try {
          const res = await fetch(url.trim(), { signal: AbortSignal.timeout(2000) });
          if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
          jwks = await res.json();
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (lastErr) throw lastErr;
      localSet = jose.createLocalJWKSet(jwks);
      lastFetch = Date.now();
    } catch (err) {
      logger.warn({ err: err.message }, 'could not refresh signing keys; keeping the cached ones');
    } finally {
      fetching = null;
    }
  })();
  return fetching;
}

export async function startJwksRefresh() {
  for (let i = 0; i < 30 && !localSet; i++) {
    await fetchJwks();
    if (!localSet) await new Promise((r) => setTimeout(r, 1000));
  }
  setInterval(fetchJwks, 5 * 60_000).unref();
}

export const jwksStatus = () => ({ keys: jwks?.keys?.map((k) => k.kid) || [], ageSec: lastFetch ? Math.round((Date.now() - lastFetch) / 1000) : null });

export async function verifyAccessToken(token) {
  if (!token) throw unauthorized();
  if (!localSet) await fetchJwks();
  if (!localSet) throw unauthorized('Signing keys not available yet');
  const opts = { issuer: config.jwtIssuer, audience: config.jwtAudience, algorithms: ['EdDSA'] };
  try {
    const { payload } = await jose.jwtVerify(token, localSet, opts);
    return { id: payload.sub, name: payload.name, role: payload.role };
  } catch (err) {
    if (err.code === 'ERR_JWKS_NO_MATCHING_KEY' && Date.now() - lastFetch > 10_000) {
      await fetchJwks(); // a key we have not seen: maybe rotated
      try {
        const { payload } = await jose.jwtVerify(token, localSet, opts);
        return { id: payload.sub, name: payload.name, role: payload.role };
      } catch {
        /* fall through */
      }
    }
    throw unauthorized(err.code === 'ERR_JWT_EXPIRED' ? 'Token expired' : 'Invalid token');
  }
}

/** Express middleware: require a valid access token. */
export function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  verifyAccessToken(token)
    .then((user) => {
      req.user = user;
      next();
    })
    .catch(next);
}

/** Express middleware: role-based access control. */
export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return next(unauthorized());
  if (!roles.includes(req.user.role)) return next(forbidden(`Needs role: ${roles.join(' or ')}`, 'ROLE_REQUIRED'));
  next();
};
