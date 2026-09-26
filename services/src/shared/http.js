// Shared Express setup: request ids, a span per request, timing metrics, one error format.
import express from 'express';
import crypto from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { AppError } from './errors.js';
import { httpDuration, metricsHandler } from './metrics.js';
import { tracer, contextFromTraceparent, SpanKind, context, trace } from './tracing.js';
import { takeToken } from './redis.js';

export function createApp({ health } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    const requestId = req.headers['x-request-id'] || crypto.randomUUID();
    req.id = requestId;
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Served-By', config.instanceId);
    const parent = contextFromTraceparent(req.headers.traceparent);
    const span = tracer().startSpan(`${req.method} ${req.path}`, { kind: SpanKind.SERVER, attributes: { 'http.method': req.method, 'http.target': req.originalUrl, 'request.id': requestId } }, parent);
    const traceId = span.spanContext().traceId;
    if (span.isRecording()) res.setHeader('X-Trace-Id', traceId);
    res.on('finish', () => {
      const route = req.route?.path ? (req.baseUrl || '') + req.route.path : 'unmatched';
      const secs = Number(process.hrtime.bigint() - started) / 1e9;
      httpDuration.labels(req.method, route, String(res.statusCode)).observe(secs);
      span.updateName(`${req.method} ${route}`);
      span.setAttribute('http.status_code', res.statusCode);
      span.end();
    });
    context.with(trace.setSpan(parent, span), next);
  });

  app.use(express.json({ limit: '64kb' }));
  app.get('/metrics', metricsHandler);
  app.get('/health', async (req, res) => {
    const checks = health ? await health() : {};
    const ok = Object.values(checks).every((v) => v === 'ok' || v === 'n/a');
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', instance: config.instanceId, checks });
  });
  return app;
}

export function finishApp(app) {
  app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint' } }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) {
      if (err.retryAfter) res.setHeader('Retry-After', err.retryAfter);
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Body is not valid JSON' } });
    logger.error({ err: err.message, stack: err.stack, path: req.path }, 'unhandled error');
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  });
}

export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Per-key token bucket as middleware. keyFn(req) decides whose bucket (user id, IP...). */
export function rateLimit(name, capacity, perSec, keyFn) {
  return ah(async (req, res, next) => {
    const r = await takeToken(`${name}:${keyFn(req)}`, capacity, perSec);
    if (r.remaining >= 0) res.setHeader('X-RateLimit-Remaining', r.remaining);
    if (!r.allowed) {
      const err = new AppError(429, 'RATE_LIMITED', 'Too many requests, slow down');
      err.retryAfter = r.retryAfterSec;
      throw err;
    }
    next();
  });
}

export function listen(app, port) {
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      logger.info({ port }, `${config.service} listening`);
      resolve(server);
    });
  });
}
