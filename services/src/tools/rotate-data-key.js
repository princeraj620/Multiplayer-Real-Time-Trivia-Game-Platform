// Re-encrypt everything with the ACTIVE data key (after adding a new key to DATA_KEYS and pointing
// DATA_KEY_ACTIVE at it). Old keys can be removed from DATA_KEYS once this has run.
//   docker compose run --rm -e SERVICE=rotate-data-key seed        (npm run rotate:data-key)
import { query, withTx } from '../shared/db.js';
import { encrypt, decrypt, keyIdOf, activeKeyId } from '../shared/crypto.js';
import { logger } from '../shared/logger.js';

export async function start() {
  const active = activeKeyId();
  let questions = 0;
  let keys = 0;
  await withTx(async (c) => {
    const qs = (await c.query(`SELECT id, correct_enc FROM questions`)).rows;
    for (const q of qs) {
      if (keyIdOf(q.correct_enc) === active) continue;
      await c.query(`UPDATE questions SET correct_enc = $2 WHERE id = $1`, [q.id, encrypt(decrypt(q.correct_enc, String(q.id)), String(q.id))]);
      questions++;
    }
    const ks = (await c.query(`SELECT kid, private_enc FROM signing_keys`)).rows;
    for (const k of ks) {
      if (keyIdOf(k.private_enc) === active) continue;
      await c.query(`UPDATE signing_keys SET private_enc = $2 WHERE kid = $1`, [k.kid, encrypt(decrypt(k.private_enc, k.kid), k.kid)]);
      keys++;
    }
  });
  await query(`INSERT INTO audit_log (action, target, detail) VALUES ('data_key_rotated', $1, $2)`, [active, { questions, signingKeys: keys }]);
  logger.info({ active, questions, signingKeys: keys }, 're-encrypted with the active data key');
  setTimeout(() => process.exit(0), 100);
  return () => {};
}
