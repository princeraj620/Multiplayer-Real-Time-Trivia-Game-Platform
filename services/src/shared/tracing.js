// Distributed tracing with OpenTelemetry.
//
// Spans are created by hand at the points that matter (an HTTP request, a WebSocket answer, an engine
// step, a Redis or PostgreSQL call inside them). The trace context travels with the answer: the gateway
// puts a W3C `traceparent` into the Redis Stream entry, and the engine continues the same trace.
// So one answer is one trace across the gateway and the engine, visible in Jaeger.
import { trace, context, propagation, SpanStatusCode, SpanKind } from '@opentelemetry/api';
import { NodeTracerProvider, BatchSpanProcessor, TraceIdRatioBasedSampler, ParentBasedSampler } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { config } from './config.js';

let provider = null;

export function initTracing() {
  if (provider) return;
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      'service.name': config.service,
      'service.instance.id': config.instanceId,
    }),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.traceSampleRatio) }),
    spanProcessors: config.otlpUrl
      ? [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${config.otlpUrl.replace(/\/$/, '')}/v1/traces` }), { maxQueueSize: 20000, maxExportBatchSize: 1000 })]
      : [],
  });
  provider.register({ propagator: new W3CTraceContextPropagator() });
}

export async function shutdownTracing() {
  if (provider) await provider.shutdown().catch(() => {});
}

export const tracer = () => trace.getTracer('buzzarena');

/** Run fn inside a new span. The span ends when fn settles; errors mark the span as failed. */
export async function traced(name, attributes, fn, { kind = SpanKind.INTERNAL, parent } = {}) {
  const ctx = parent || context.active();
  return tracer().startActiveSpan(name, { kind, attributes }, ctx, async (span) => {
    try {
      const out = await fn(span);
      return out;
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Build a context from a traceparent string (from an HTTP header or a stream entry). */
export function contextFromTraceparent(traceparent) {
  if (!traceparent) return context.active();
  return propagation.extract(context.active(), { traceparent });
}

/** The traceparent of the current span, to send along with a message. */
export function currentTraceparent() {
  const carrier = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent || '';
}

export function currentTraceId() {
  const span = trace.getSpan(context.active());
  const id = span?.spanContext().traceId;
  return id && id !== '00000000000000000000000000000000' ? id : undefined;
}

export { SpanKind, trace, context };
