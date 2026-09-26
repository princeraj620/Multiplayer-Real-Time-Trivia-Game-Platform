// Prometheus metrics. Every service exposes GET /metrics; Prometheus scrapes it every 5 seconds.
import client from 'prom-client';
import { config } from './config.js';

export const registry = new client.Registry();
registry.setDefaultLabels({ service: config.service, instance: config.instanceId });
client.collectDefaultMetrics({ register: registry, prefix: 'buzz_process_' });

export const counter = (name, help, labelNames = []) => new client.Counter({ name, help, labelNames, registers: [registry] });
export const gauge = (name, help, labelNames = [], collect) => new client.Gauge({ name, help, labelNames, registers: [registry], ...(collect ? { collect } : {}) });
export const histogram = (name, help, labelNames = [], buckets) =>
  new client.Histogram({ name, help, labelNames, registers: [registry], ...(buckets ? { buckets } : {}) });

export const httpDuration = histogram('buzz_http_request_duration_seconds', 'HTTP request time', ['method', 'route', 'status'], [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5]);

export async function metricsHandler(req, res) {
  res.setHeader('Content-Type', registry.contentType);
  res.end(await registry.metrics());
}
