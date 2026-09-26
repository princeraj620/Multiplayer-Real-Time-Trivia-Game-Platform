// Each instance reports a small status snapshot into Redis every second (with a 5 s expiry).
// The live dashboard reads these, so a dead instance disappears on its own.
import { redis, keys } from './redis.js';
import { config } from './config.js';

export function startOpsReporter(snapshotFn, intervalMs = 1000) {
  const key = keys.instance(config.service, config.instanceId);
  const startedAt = Date.now();
  const tick = async () => {
    try {
      const snap = await snapshotFn();
      await redis.set(key, JSON.stringify({ service: config.service, instance: config.instanceId, pid: process.pid, startedAt, at: Date.now(), ...snap }), 'PX', 5000);
    } catch {
      /* Redis down: the dashboard will show this instance as missing */
    }
  };
  tick();
  return setInterval(tick, intervalMs);
}
