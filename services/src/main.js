// One Docker image, many services: SERVICE=<name> picks which one runs (same pattern as Project 3).
import { initTracing, shutdownTracing } from './shared/tracing.js';
import { config } from './shared/config.js';

initTracing();
const { logger } = await import('./shared/logger.js');

const services = {
  auth: () => import('./auth/index.js'),
  lobby: () => import('./lobby/index.js'),
  gateway: () => import('./gateway/index.js'),
  engine: () => import('./engine/index.js'),
  seed: () => import('./seed/index.js'),
  'rotate-data-key': () => import('./tools/rotate-data-key.js'),
};

const load = services[config.service];
if (!load) {
  logger.error(`Unknown SERVICE "${config.service}". Use one of: ${Object.keys(services).join(', ')}`);
  process.exit(1);
}

const mod = await load();
const stop = await mod.start();

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down');
  try {
    if (typeof stop === 'function') await stop();
  } catch (err) {
    logger.warn({ err: err.message }, 'error while stopping');
  }
  await shutdownTracing();
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err: err?.message, stack: err?.stack }, 'unhandled rejection'));
