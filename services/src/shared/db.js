// PostgreSQL: the primary takes every write; the read replica (Project 2) serves history,
// results and all-time leaderboards. If the replica is down, reads fall back to the primary.
import pg from 'pg';
import { config } from './config.js';
import { traced } from './tracing.js';
import { logger } from './logger.js';

pg.types.setTypeParser(20, (v) => Number(v)); // bigint -> number (values here stay far below 2^53)

export const primary = new pg.Pool({ connectionString: config.pgPrimaryUrl, max: 10, connectionTimeoutMillis: 3000 });
export const replica = new pg.Pool({ connectionString: config.pgReplicaUrl, max: 10, connectionTimeoutMillis: 3000 });
primary.on('error', (e) => logger.warn({ err: e.message }, 'pg primary pool error'));
replica.on('error', (e) => logger.warn({ err: e.message }, 'pg replica pool error'));

function spanName(sql) {
  return 'pg ' + sql.trim().split(/\s+/)[0].toUpperCase();
}

export function query(sql, params = []) {
  return traced(spanName(sql), { 'db.system': 'postgresql', 'db.statement': sql.slice(0, 200), 'db.target': 'primary' }, () => primary.query(sql, params));
}

let replicaDownUntil = 0;
/** Read from the replica; on error, read from the primary for the next 10 s (a small circuit breaker). */
export async function readQuery(sql, params = []) {
  if (Date.now() > replicaDownUntil) {
    try {
      const res = await traced(spanName(sql), { 'db.system': 'postgresql', 'db.statement': sql.slice(0, 200), 'db.target': 'replica' }, () => replica.query(sql, params));
      res.readFrom = 'replica';
      return res;
    } catch (err) {
      replicaDownUntil = Date.now() + 10_000;
      logger.warn({ err: err.message }, 'replica read failed, using the primary for 10 s');
    }
  }
  const res = await query(sql, params);
  res.readFrom = 'primary';
  return res;
}

export async function withTx(fn) {
  const client = await primary.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
