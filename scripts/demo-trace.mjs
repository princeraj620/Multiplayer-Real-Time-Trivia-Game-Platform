// Demo: follow ONE answer through the whole system with distributed tracing and logs.
//   npm run demo:trace
//
// "Why did my answer not count?" The answer's acknowledgement carries a trace id. The same id is on
// the span the gateway created, the Redis write, the span the leader engine created when it recorded
// the answer, and on every log line those steps wrote. Jaeger shows the spans; Loki finds the logs.
import { login, createGame, startGame, Player, sleep } from './lib/client.mjs';
import { say, step, explain, ok, bad, bold, cyan, dim, green } from './lib/say.mjs';

const JAEGER = process.env.JAEGER_URL || 'http://localhost:16686';
const LOKI = process.env.LOKI_URL || 'http://localhost:3100';

step('Playing one question');
const [host, asha] = await Promise.all([login('meera'), login('asha')]);
const gameId = await createGame(host.token, { title: 'Trace demo', packSlug: 'cs-basics', questionCount: 2, questionSec: 5 });
const p = new Player({ token: asha.token, name: 'Asha', gameId });
await p.connect();
p.join();
await sleep(500);
await startGame(host.token, gameId);
const q = await p.waitFor('question', 30_000);
say(`Question: "${q.text}"`);
await sleep(1200);
p.send({ type: 'answer', gameId, q: q.q, choice: 1 });
const ack = await p.waitFor('answer_ack');
say(`Asha answers B. The gateway replies ${bold(ack.status)} with trace id ${cyan(ack.traceId || '(not sampled)')}`);
if (!ack.traceId) {
  say(dim('This answer was not sampled (TRACE_SAMPLE_RATIO < 1). Run again, or set TRACE_SAMPLE_RATIO=1.'));
  process.exit(0);
}
const you = await p.waitFor('you', 30_000);
say(`Reveal: ${you.correct ? green(`correct, +${you.points} points`) : 'not correct'}`);
p.close();
await sleep(3000); // spans are exported in batches every second

step('The trace, from Jaeger');
const t = await fetch(`${JAEGER}/api/traces/${ack.traceId}`).then((r) => r.json()).catch(() => null);
const trace = t?.data?.[0];
if (!trace) {
  bad(`Jaeger has no trace ${ack.traceId} yet (is Jaeger running at ${JAEGER}?)`);
} else {
  const spans = trace.spans.sort((a, b) => a.startTime - b.startTime);
  const start = spans[0].startTime;
  const byId = new Map(spans.map((s) => [s.spanID, s]));
  const depth = (s) => {
    let d = 0;
    let ref = s.references?.find((r) => r.refType === 'CHILD_OF');
    while (ref && byId.has(ref.spanID)) {
      d++;
      ref = byId.get(ref.spanID).references?.find((r) => r.refType === 'CHILD_OF');
    }
    return d;
  };
  for (const s of spans) {
    const svc = trace.processes[s.processID].serviceName;
    const inst = trace.processes[s.processID].tags.find((x) => x.key === 'service.instance.id')?.value;
    const tags = Object.fromEntries(s.tags.map((x) => [x.key, x.value]));
    const extra = tags['answer.result'] ? ` result=${bold(tags['answer.result'])}` : tags['answer.ms_before_deadline'] ? ` ${tags['answer.ms_before_deadline']} ms before the deadline` : '';
    console.log(`  ${'  '.repeat(depth(s))}${dim(`+${((s.startTime - start) / 1000).toFixed(1).padStart(6)} ms`)}  ${bold(s.operationName.padEnd(22))} ${cyan(inst || svc)}  ${(s.duration / 1000).toFixed(2)} ms${extra}`);
  }
  ok(`${spans.length} spans from ${new Set(spans.map((s) => trace.processes[s.processID].serviceName)).size} services in one trace`);
  say(`Open it: ${JAEGER}/trace/${ack.traceId}`);
}

step('The logs for the same trace id, from Loki');
const url = `${LOKI}/loki/api/v1/query_range?query=${encodeURIComponent(`{app="buzzarena"} |= "${ack.traceId}"`)}&limit=20&start=${(Date.now() - 600_000) * 1e6}`;
const logs = await fetch(url).then((r) => r.json()).catch(() => null);
const lines = (logs?.data?.result || []).flatMap((s) => s.values.map(([ts, line]) => ({ ts: Number(ts), line, svc: s.stream.instance }))).sort((a, b) => a.ts - b.ts);
if (!lines.length) bad(`No log lines found in Loki (is it running at ${LOKI}?)`);
for (const l of lines) {
  const j = JSON.parse(l.line);
  console.log(`  ${cyan(l.svc.padEnd(10))} ${j.msg}  ${dim(JSON.stringify({ q: j.q, choice: j.choice, result: j.result, msBeforeDeadline: j.msBeforeDeadline }))}`);
}
if (lines.length) ok(`${lines.length} log lines carry trace_id ${ack.traceId.slice(0, 12)}…`);
explain('In Grafana, clicking the trace id in a log line opens this trace, and a span links back to its logs.');
setTimeout(() => process.exit(0), 200);
