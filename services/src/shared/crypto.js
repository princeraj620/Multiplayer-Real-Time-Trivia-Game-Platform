// Encryption at rest with AES-256-GCM.
//
// The correct answers in the question bank and the JWT signing keys are stored encrypted. Every
// ciphertext records which key made it ("k1:..."), so keys can be rotated: new data uses the active
// key, old data still decrypts with the old key until it is re-encrypted (npm run rotate:data-key).
import crypto from 'node:crypto';
import { config } from './config.js';

function loadKeys() {
  const ring = new Map();
  for (const part of config.dataKeys.split(',')) {
    const [kid, b64] = part.split(':');
    if (!kid || !b64) continue;
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) throw new Error(`data key ${kid} must be 32 bytes (base64)`);
    ring.set(kid.trim(), key);
  }
  if (!ring.has(config.dataKeyActive)) throw new Error(`DATA_KEY_ACTIVE=${config.dataKeyActive} is not in DATA_KEYS`);
  return ring;
}
const ring = loadKeys();

export const activeKeyId = () => config.dataKeyActive;

/** "kid:iv:tag:ciphertext" (base64 parts). `aad` binds the ciphertext to its row (e.g. the question id). */
export function encrypt(plaintext, aad = '') {
  const kid = config.dataKeyActive;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ring.get(kid), iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [kid, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decrypt(blob, aad = '') {
  const [kid, iv, tag, ct] = blob.split(':');
  const key = ring.get(kid);
  if (!key) throw new Error(`unknown data key ${kid}`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  if (aad) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

export const keyIdOf = (blob) => blob.split(':')[0];

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
