// Seed: question bank (answers encrypted), demo accounts, a few finished games for history,
// and scheduled games ready to start. Safe to run again: it only adds what is missing.
import { hash, Algorithm } from '@node-rs/argon2';
import { query, withTx } from '../shared/db.js';
import { redis, keys } from '../shared/redis.js';
import { encrypt } from '../shared/crypto.js';
import { logger } from '../shared/logger.js';
import { PACKS, USERS } from './data.js';

const ARGON = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

async function waitForDb() {
  for (let i = 0; i < 60; i++) {
    try {
      await query('SELECT 1 FROM games LIMIT 1');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('database not ready');
}

function rand(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

export async function start() {
  await waitForDb();

  // 1. The question bank.
  const have = (await query(`SELECT count(*)::int AS n FROM question_packs`)).rows[0].n;
  if (!have) {
    await withTx(async (c) => {
      for (const p of PACKS) {
        const packId = (await c.query(`INSERT INTO question_packs (slug, title, category, description, emoji) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [p.slug, p.title, p.category, p.description, p.emoji])).rows[0].id;
        for (const [text, options, correct, fact] of p.questions) {
          const id = (await c.query(`INSERT INTO questions (pack_id, text, options, correct_enc, fact) VALUES ($1,$2,$3,'pending',$4) RETURNING id`, [packId, text, options, fact])).rows[0].id;
          // The answer is encrypted and bound to this question id (AAD).
          await c.query(`UPDATE questions SET correct_enc = $2 WHERE id = $1`, [id, encrypt(String(correct), String(id))]);
        }
      }
    });
    logger.info({ packs: PACKS.length, questions: PACKS.reduce((n, p) => n + p.questions.length, 0) }, 'question bank created (answers encrypted)');
  }

  // 2. Demo accounts (argon2id password hashes).
  for (const u of USERS) {
    const exists = await query(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [u.email]);
    if (exists.rowCount) continue;
    await query(`INSERT INTO users (email, name, role, password_hash) VALUES ($1,$2,$3,$4)`, [u.email, u.name, u.role, await hash(u.password, ARGON)]);
  }
  const users = Object.fromEntries((await query(`SELECT id, name, email FROM users WHERE NOT is_bot`)).rows.map((r) => [r.email.split('@')[0], r]));

  // 3. A crowd of past players, and three finished games for history and the all-time leaderboard.
  const finished = (await query(`SELECT count(*)::int AS n FROM games WHERE status = 'FINISHED'`)).rows[0].n;
  if (!finished) {
    const crowd = (await query(
      `INSERT INTO users (email, name, is_bot) SELECT 'crowd-' || i || '@bots.buzzarena.dev', 'player-' || lpad(i::text, 3, '0'), true FROM generate_series(1, 180) i
       ON CONFLICT (lower(email)) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    )).rows.map((r) => r.id);
    const past = [
      { title: 'Sunday Warm-up', pack: 'general', host: 'meera', daysAgo: 6, n: 8 },
      { title: 'Tech Night #1', pack: 'cs-basics', host: 'rohan', daysAgo: 4, n: 10 },
      { title: 'India Quiz Night #1', pack: 'india', host: 'meera', daysAgo: 2, n: 8 },
    ];
    const humans = ['asha', 'kabir', 'priya', 'vikram', 'zoya'].map((k) => users[k].id);
    for (const [gi, p] of past.entries()) {
      const r = rand(gi + 7);
      const packId = (await query(`SELECT id FROM question_packs WHERE slug = $1`, [p.pack])).rows[0].id;
      const qids = (await query(`SELECT id FROM questions WHERE pack_id = $1 ORDER BY id LIMIT $2`, [packId, p.n])).rows.map((x) => x.id);
      const players = [...humans, ...crowd.slice(gi * 40, gi * 40 + 140)];
      const rows = players.map((id) => {
        const correct = Math.min(p.n, Math.floor(r() * (p.n + 1) * 0.9 + (humans.includes(id) ? 3 : 0)));
        const score = correct * (500 + Math.floor(r() * 450));
        return { id, correct, score, survived: correct === p.n };
      });
      rows.sort((a, b) => b.score - a.score);
      await withTx(async (c) => {
        const g = (await c.query(
          `INSERT INTO games (title, host_id, pack_id, status, question_ids, scheduled_at, started_at, finished_at, player_count, survivor_count, finished_by, leader_token)
           VALUES ($1,$2,$3,'FINISHED',$4, now() - make_interval(days => $5), now() - make_interval(days => $5), now() - make_interval(days => $5) + interval '4 minutes', $6, $7, 'engine-1', 1)
           RETURNING id`,
          [p.title, users[p.host].id, packId, qids, p.daysAgo, rows.length, rows.filter((x) => x.survived).length],
        )).rows[0].id;
        await c.query(
          `INSERT INTO game_results (game_id, user_id, score, rank, correct_count, survived)
           SELECT $1, u, s, rk, cc, sv FROM unnest($2::uuid[], $3::int[], $4::int[], $5::int[], $6::bool[]) AS t(u, s, rk, cc, sv)`,
          [g, rows.map((x) => x.id), rows.map((x) => x.score), rows.map((_, i) => i + 1), rows.map((x) => x.correct), rows.map((x) => x.survived)],
        );
      });
    }
    logger.info('3 finished games added for history');
  }

  // 4. Scheduled games, ready for a host to press Start.
  const scheduled = (await query(`SELECT count(*)::int AS n FROM games WHERE status = 'SCHEDULED'`)).rows[0].n;
  if (!scheduled) {
    const upcoming = [
      { title: 'Friday Night Trivia', pack: 'general', host: 'meera', n: 8, mins: 10 },
      { title: 'System Design Showdown', pack: 'system-design', host: 'rohan', n: 10, mins: 30 },
      { title: 'India Quiz Night', pack: 'india', host: 'meera', n: 8, mins: 60 },
      { title: 'Game, Set, Quiz', pack: 'sports', host: 'rohan', n: 6, mins: 120 },
    ];
    for (const u of upcoming) {
      const packId = (await query(`SELECT id FROM question_packs WHERE slug = $1`, [u.pack])).rows[0].id;
      const qids = (await query(`SELECT id FROM questions WHERE pack_id = $1 ORDER BY random() LIMIT $2`, [packId, u.n])).rows.map((x) => x.id);
      await query(`INSERT INTO games (title, host_id, pack_id, question_ids, scheduled_at) VALUES ($1,$2,$3,$4, now() + make_interval(mins => $5))`, [u.title, users[u.host].id, packId, qids, u.mins]);
    }
    logger.info('4 scheduled games added');
  }

  // 5. Make sure every scheduled game has its Redis config (the gateways check it when players join).
  const games = (await query(`SELECT g.*, u.name AS host_name FROM games g JOIN users u ON u.id = g.host_id WHERE g.status = 'SCHEDULED'`)).rows;
  for (const g of games) {
    await redis.set(keys.gameConfig(g.id), JSON.stringify({ title: g.title, hostId: g.host_id, hostName: g.host_name, packId: g.pack_id, questionIds: g.question_ids, questionSec: g.question_sec }));
    await redis.hsetnx(keys.gameState(g.id), 'phase', 'LOBBY');
  }
  logger.info('seed complete');
  await redis.quit();
  setTimeout(() => process.exit(0), 100);
  return () => {};
}
