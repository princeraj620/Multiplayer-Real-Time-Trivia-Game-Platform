// Leader election with etcd (Raft consensus underneath).
//
// Every engine keeps ONE lease in etcd (a session with a 5 s TTL, renewed every ~1.7 s). To lead a
// game, an engine creates the key /buzzarena/leaders/<gameId> attached to its lease, in a transaction
// that only succeeds if the key does not exist yet. etcd is replicated with Raft, so a majority of the
// 3 etcd nodes must agree on that write: two engines can never both succeed.
//
// The revision of that write is the FENCING TOKEN. Revisions only ever grow, so a newer leader always
// has a bigger token than any older one. Every write the engine makes to Redis or PostgreSQL carries
// the token, and writes with an older token are rejected (see fencedPublish in shared/redis.js).
//
// If the engine cannot renew its lease (it crashed, froze, or lost contact with the etcd majority),
// etcd deletes the key after the TTL, and another engine can take over. The engine also stops acting
// on its own as soon as it cannot prove its lease is still alive ("self-fencing").
import { EventEmitter } from 'node:events';
import { Etcd3 } from 'etcd3';
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';

export const PREFIX = '/buzzarena/';
export const gameKey = (g) => `${PREFIX}games/${g}`;
export const leaderKey = (g) => `${PREFIX}leaders/${g}`;

export function createEtcd() {
  return new Etcd3({ hosts: config.etcdEndpoints, dialTimeout: 1500, defaultCallOptions: () => ({ deadline: Date.now() + 2500 }) });
}

export class Elector extends EventEmitter {
  constructor(client, id, ttlSec) {
    super();
    this.client = client;
    this.id = id;
    this.ttlSec = ttlSec;
    this.lease = null;
    this.leaseId = null;
    this.lastOk = 0;
    this.granting = null;
    this.watchdog = setInterval(() => this.check(), 250);
  }

  /** True while we can prove the lease is alive (renewed within TTL minus a safety margin). */
  isHealthy() {
    return !!this.leaseId && Date.now() - this.lastOk < this.ttlSec * 1000 - 1200;
  }

  check() {
    if (config.selfFencing && this.leaseId && !this.isHealthy()) this.dropLease('keepalive too old: assuming the lease is gone');
  }

  dropLease(reason) {
    if (!this.leaseId) return;
    logger.warn({ leaseId: this.leaseId, reason }, 'lost the etcd lease: stepping down from every game');
    const old = this.lease;
    this.lease = null;
    this.leaseId = null;
    try {
      old?.release();
    } catch {
      /* ignore */
    }
    this.emit('lost', reason);
  }

  async ensureLease() {
    if (this.leaseId && this.isHealthy()) return this.leaseId;
    if (this.granting) return this.granting;
    this.granting = (async () => {
      const lease = this.client.lease(this.ttlSec, { autoKeepAlive: true });
      lease.on('keepaliveSucceeded', () => {
        if (this.lease === lease) this.lastOk = Date.now();
      });
      lease.on('lost', (err) => {
        if (this.lease === lease) this.dropLease(err?.message || 'lease lost');
      });
      lease.on('error', () => {});
      const id = await lease.grant();
      this.lease = lease;
      this.leaseId = id;
      this.lastOk = Date.now();
      logger.info({ leaseId: id, ttl: this.ttlSec }, 'etcd lease granted');
      return id;
    })().finally(() => {
      this.granting = null;
    });
    return this.granting;
  }

  /** Try to become leader of a game. Returns the fencing token, or null if someone else leads
   *  (or the game no longer needs a leader). Both conditions are checked in one etcd transaction. */
  async campaign(gameId) {
    const leaseId = await this.ensureLease();
    const key = leaderKey(gameId);
    const res = await this.client
      .if(gameKey(gameId), 'Version', '>', 0)
      .and(key, 'Create', '==', 0)
      .then(this.client.put(key).value(this.id).lease(leaseId))
      .else(this.client.get(key))
      .commit();
    if (res.succeeded) return Number(res.header.revision);
    return null;
  }

  /** Give up leadership, only if the key is still ours (same create revision). */
  async resign(gameId, token) {
    try {
      await this.client.if(leaderKey(gameId), 'Create', '==', token).then(this.client.delete().key(leaderKey(gameId))).commit();
    } catch (err) {
      logger.warn({ err: err.message, gameId }, 'resign failed (the lease will expire anyway)');
    }
  }

  async currentLeader(gameId) {
    const res = await this.client.get(leaderKey(gameId)).exec();
    const kv = res.kvs[0];
    return kv ? { engine: kv.value.toString(), token: Number(kv.create_revision) } : null;
  }

  status() {
    return { leaseId: this.leaseId, healthy: this.isHealthy(), lastKeepaliveMsAgo: this.lastOk ? Date.now() - this.lastOk : null, ttlSec: this.ttlSec };
  }

  close() {
    clearInterval(this.watchdog);
    try {
      this.lease?.revoke().catch(() => {});
    } catch {
      /* ignore */
    }
  }
}
