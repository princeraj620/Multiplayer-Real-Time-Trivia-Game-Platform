// Structured JSON logs. Every line carries the service, the instance and (when there is one) the
// trace id, so a log search for one trace id finds every line that request or answer produced.
// When LOKI_URL is set, logs are also pushed to Loki.
import pino from 'pino';
import { config } from './config.js';
import { currentTraceId } from './tracing.js';

function buildTransport() {
  if (!config.lokiUrl) return undefined;
  return pino.transport({
    targets: [
      { target: 'pino/file', options: { destination: 1 }, level: config.logLevel },
      {
        target: 'pino-loki',
        level: config.logLevel,
        options: {
          host: config.lokiUrl,
          batching: { interval: 1 },
          labels: { app: 'buzzarena', service: config.service, instance: config.instanceId },
        },
      },
    ],
  });
}

export const logger = pino(
  {
    level: config.logLevel,
    base: { service: config.service, instance: config.instanceId },
    mixin() {
      const traceId = currentTraceId();
      return traceId ? { trace_id: traceId } : {};
    },
  },
  buildTransport(),
);
