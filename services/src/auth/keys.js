// JWT signing keys: Ed25519, private key encrypted at rest, public keys published as a JWKS.
// Rotation: a new active key signs new tokens; old public keys stay in the JWKS for a day so
// tokens signed before the rotation keep working until they expire.
import * as jose from 'jose';
import crypto from 'node:crypto';
import { query, withTx } from '../shared/db.js';
import { encrypt, decrypt } from '../shared/crypto.js';
import { logger } from '../shared/logger.js';

let active = null; // { kid, privateKey }
let jwks = { keys: [] };

async function generateKey(client) {
  const { publicKey, privateKey } = await jose.generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const kid = `ed25519-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
  const pub = { ...(await jose.exportJWK(publicKey)), kid, alg: 'EdDSA', use: 'sig' };
  const priv = await jose.exportJWK(privateKey);
  const r = await client.query(
    `INSERT INTO signing_keys (kid, public_jwk, private_enc, active) VALUES ($1, $2, $3, true)
     ON CONFLICT DO NOTHING RETURNING kid`,
    [kid, pub, encrypt(JSON.stringify(priv), kid)],
  );
  return r.rowCount ? kid : null;
}

export async function loadKeys() {
  let rows = (await query(`SELECT kid, public_jwk, private_enc, active FROM signing_keys WHERE active OR retired_at > now() - interval '1 day' ORDER BY created_at DESC`)).rows;
  if (!rows.some((r) => r.active)) {
    await withTx((c) => generateKey(c)).catch(() => null); // another instance may win the race: fine
    rows = (await query(`SELECT kid, public_jwk, private_enc, active FROM signing_keys WHERE active OR retired_at > now() - interval '1 day' ORDER BY created_at DESC`)).rows;
  }
  const a = rows.find((r) => r.active);
  if (!active || active.kid !== a.kid) {
    const jwk = JSON.parse(decrypt(a.private_enc, a.kid));
    active = { kid: a.kid, privateKey: await jose.importJWK(jwk, 'EdDSA') };
    logger.info({ kid: a.kid }, 'signing key loaded');
  }
  jwks = { keys: rows.map((r) => r.public_jwk) };
}

export async function rotateKey() {
  const kid = await withTx(async (c) => {
    await c.query(`UPDATE signing_keys SET active = false, retired_at = now() WHERE active`);
    return generateKey(c);
  });
  await loadKeys();
  return kid;
}

export const getJwks = () => jwks;
export const getActive = () => active;
