import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const PHASES = ['LOBBY', 'COUNTDOWN', 'QUESTION', 'LOCKED', 'REVEAL', 'LEADERBOARD', 'FINISHED'];
const SERIES_COLORS = ['var(--opt-b)', 'var(--opt-c)', 'var(--opt-d)', 'var(--opt-a)', 'var(--amber)'];
const N = 90; // seconds of history

function Chart({ series, height = 150, unit = '', max }) {
  const w = 600;
  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  const top = max ?? Math.max(1, ...all) * 1.15;
  const x = (i) => (i / (N - 1)) * w;
  const y = (v) => height - (v / top) * (height - 8) - 4;
  const fmt = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : Math.round(v));
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height} preserveAspectRatio="none" role="img" aria-label={series.map((s) => s.name).join(', ')}>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={w} y1={height * f} y2={height * f} stroke="var(--line)" strokeWidth="1" strokeDasharray="3 5" />
        ))}
        {series.map((s, si) => {
          const pts = s.values.map((v, i) => (v == null ? null : `${x(i + N - s.values.length)},${y(v)}`)).filter(Boolean);
          return <polyline key={si} points={pts.join(' ')} fill="none" stroke={s.color} strokeWidth="2.2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />;
        })}
      </svg>
      <div className="chart-legend">
        {series.map((s) => (
          <span key={s.name}>
            <i style={{ background: s.color }} />
            {s.name} {s.values.length ? <b className="num">{fmt(s.values[s.values.length - 1] ?? 0)}{unit}</b> : null}
          </span>
        ))}
        <span style={{ marginLeft: 'auto' }}>
          last {N} s, top of chart {fmt(top)}
          {unit}
        </span>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div className="card stat span-2">
      <div className="v" style={tone ? { color: tone } : undefined}>{value}</div>
      <div className="l">{label}</div>
    </div>
  );
}

export default function Dashboard() {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const hist = useRef({ conns: {}, answers: [], fanout: [], total: [] });
  const seen = useRef({});

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const data = await api('GET', '/api/ops/overview');
        if (!alive) return;
        const h = hist.current;
        const push = (arr, v) => {
          arr.push(v);
          if (arr.length > N) arr.shift();
        };
        for (const g of data.gateways) {
          h.conns[g.instance] ??= [];
          seen.current[g.instance] = { at: Date.now(), svc: 'gateway' };
        }
        for (const e of data.engines) seen.current[e.instance] = { at: Date.now(), svc: 'engine' };
        for (const [name, arr] of Object.entries(h.conns)) push(arr, data.gateways.find((g) => g.instance === name)?.connections ?? 0);
        push(h.total, data.gateways.reduce((a, g) => a + g.connections, 0));
        push(h.answers, data.gateways.reduce((a, g) => a + (g.answersPerSec || 0), 0));
        const fan = data.gateways.map((g) => g.lastQuestionFanoutMs).filter((v) => v != null);
        push(h.fanout, fan.length ? Math.max(...fan) : null);
        setD(data);
        setError(null);
      } catch (err) {
        if (alive) setError(err.message);
      }
    }
    load();
    const t = setInterval(load, 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!d) return <main className="dash">{error ? <div className="error-box">{error}</div> : <p className="muted">Loading…</p>}</main>;

  const h = hist.current;
  const connTotal = d.gateways.reduce((a, g) => a + g.connections, 0);
  const aps = d.gateways.reduce((a, g) => a + (g.answersPerSec || 0), 0);
  const fanMs = h.fanout[h.fanout.length - 1];
  const firing = (d.alerts || []).filter((a) => a.state === 'firing');
  const downOf = (svc, live) => Object.entries(seen.current).filter(([name, v]) => v.svc === svc && !live.some((x) => x.instance === name) && Date.now() - v.at < 300_000).map(([name]) => name);
  const gwDown = downOf('gateway', d.gateways);
  const engDown = downOf('engine', d.engines);
  const healthyEngines = d.engines.filter((e) => e.election?.healthy).length;
  const leaderMember = d.etcd.members.find((m) => m.isLeader);
  const upMembers = d.etcd.members.filter((m) => m.up).length;
  const auth = d.auths.reduce((a, x) => ({ logins: a.logins + (x.logins || 0), failed: a.failed + (x.failedLogins || 0), reuse: a.reuse + (x.reuseDetected || 0), tickets: a.tickets + (x.tickets || 0), kid: x.kid || a.kid }), { logins: 0, failed: 0, reuse: 0, tickets: 0, kid: '' });

  return (
    <main className="dash">
      <div className="row between wrap" style={{ marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: '2rem' }}>Control room</h1>
          <p className="muted">Everything on this page refreshes every second.</p>
        </div>
        <div className="row wrap">
          <a className="btn ghost small" href={d.links.jaeger} target="_blank" rel="noreferrer">Traces (Jaeger)</a>
          <a className="btn ghost small" href={d.links.grafana} target="_blank" rel="noreferrer">Grafana</a>
          <a className="btn ghost small" href={d.links.prometheus} target="_blank" rel="noreferrer">Prometheus</a>
        </div>
      </div>
      {error && <div className="error-box" style={{ marginBottom: 12 }}>Dashboard data is stale: {error}</div>}

      <div className="dash-grid">
        <Stat label="players connected" value={connTotal.toLocaleString()} />
        <Stat label="answers per second" value={aps.toLocaleString()} />
        <Stat label="live games" value={d.games.length} />
        <Stat label="question fan-out, slowest gateway" value={fanMs != null ? `${Math.round(fanMs)} ms` : '–'} />
        <Stat label="engines with a healthy lease" value={`${healthyEngines} of ${d.engines.length + engDown.length}`} tone={healthyEngines < d.engines.length + engDown.length ? 'var(--warn)' : undefined} />
        <Stat label="alerts firing" value={d.alerts == null ? '–' : firing.length} tone={firing.length ? 'var(--bad)' : 'var(--good)'} />

        <section className="card span-7">
          <h3>
            Live games <small>one leader per game, chosen through etcd</small>
          </h3>
          {d.games.length === 0 && <p className="muted">No game is on air. Start one from a host console.</p>}
          <div className="stack">
            {d.games.map((g) => {
              const stale = g.beatMsAgo != null && g.beatMsAgo > 1500;
              return (
                <div key={g.id} className="game-card" style={{ background: 'var(--stage-deep)', borderRadius: 12, padding: 14 }}>
                  <div className="row between wrap">
                    <b style={{ fontSize: '1.05rem' }}>{g.title}</b>
                    <span className="row" style={{ gap: 6 }}>
                      <span className="tag">{g.phase === 'QUESTION' || g.phase === 'REVEAL' || g.phase === 'LOCKED' ? `Q${g.q + 1} of ${g.total}, ${g.phase.toLowerCase()}` : (g.phase || 'starting').toLowerCase()}</span>
                      {stale ? <span className="tag bad">no leader heartbeat for {(g.beatMsAgo / 1000).toFixed(1)} s</span> : <span className="tag ok">leader alive</span>}
                    </span>
                  </div>
                  <div className="phase-track">
                    {PHASES.map((p, i) => (
                      <span key={p} className={p === g.phase ? 'now' : PHASES.indexOf(g.phase) > i ? 'done' : ''} />
                    ))}
                  </div>
                  <dl className="kv" style={{ gridTemplateColumns: 'repeat(4, auto 1fr)' }}>
                    <dt>Leader</dt>
                    <dd>{g.etcdLeader?.engine || <span style={{ color: 'var(--bad)' }}>electing…</span>}</dd>
                    <dt>Fencing token</dt>
                    <dd className="num">{g.token}</dd>
                    <dt>Redis fence</dt>
                    <dd className="num">{g.fence}</dd>
                    <dt>DB fence</dt>
                    <dd className="num">{g.leader_token}</dd>
                    <dt>Players</dt>
                    <dd className="num">{g.players.toLocaleString()}</dd>
                    <dt>Still in</dt>
                    <dd className="num">{g.survivors.toLocaleString()}</dd>
                    <dt>Answered</dt>
                    <dd className="num">{g.answered.toLocaleString()}</dd>
                    <dt>In stream</dt>
                    <dd className="num">{g.answersInStream.toLocaleString()}</dd>
                  </dl>
                </div>
              );
            })}
          </div>
        </section>

        <section className="card span-5">
          <h3>
            Connections per gateway <small>least-connections balancing</small>
          </h3>
          <Chart series={Object.entries(h.conns).map(([name, values], i) => ({ name, values, color: SERIES_COLORS[i % SERIES_COLORS.length] }))} />
        </section>

        <section className="card span-4">
          <h3>
            WebSocket gateways <small>{d.gateways.length} up</small>
          </h3>
          {d.gateways.map((g) => (
            <div key={g.instance} className="inst">
              <span className="name"><span className="dot" />{g.instance}</span>
              <span className="num">{g.connections.toLocaleString()} sockets</span>
              <div className="meter"><div style={{ width: `${Math.min(100, (g.connections / Math.max(1, connTotal)) * 100)}%` }} /></div>
              <span className="sub">
                {g.answersPerSec}/s answers in, {g.sentPerSec.toLocaleString()}/s messages out, {g.memMb} MB
                {g.lastQuestionFanoutMs != null ? `, fan-out ${g.lastQuestionFanoutMs} ms` : ''}
              </span>
            </div>
          ))}
          {gwDown.map((n) => (
            <div key={n} className="inst down">
              <span className="name"><span className="dot bad" />{n}</span>
              <span className="tag bad">down</span>
              <span className="sub">Its players reconnect to the other gateways and resume.</span>
            </div>
          ))}
        </section>

        <section className="card span-4">
          <h3>
            Game engines <small>leases in etcd</small>
          </h3>
          {d.engines.map((e) => (
            <div key={e.instance} className="inst">
              <span className="name">
                <span className={`dot ${e.election?.healthy ? '' : 'bad'}`} />
                {e.instance}
              </span>
              <span>{e.games.length ? e.games.map((g) => <span key={g.gameId} className="tag leader" style={{ marginLeft: 4 }}>leader, token {g.token}</span>) : <span className="tag">standby</span>}</span>
              <span className="sub">
                lease {e.election?.healthy ? `renewed ${e.election.lastKeepaliveMsAgo} ms ago` : 'NOT renewed'}
                {e.games.map((g) => `, ${g.title}: ${String(g.phase).toLowerCase()} Q${g.q + 1}, stream lag ${g.lag}`).join('')}
              </span>
              {e.recent?.length > 0 && (
                <div className="events" style={{ gridColumn: 'span 2' }}>
                  {e.recent.slice(0, 3).map((r, i) => (
                    <span key={i}>
                      {new Date(r.at).toLocaleTimeString()} {r.type.replace('-', ' ')} {r.token ? `(token ${r.token})` : ''} {r.reason ? `: ${r.reason}` : ''}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
          {engDown.map((n) => (
            <div key={n} className="inst down">
              <span className="name"><span className="dot bad" />{n}</span>
              <span className="tag bad">down</span>
              <span className="sub">Its games are taken over when its lease expires (5 s).</span>
            </div>
          ))}
        </section>

        <section className="card span-4">
          <h3>
            etcd cluster <small>Raft: {upMembers} of {d.etcd.members.length} members up, {upMembers >= 2 ? 'majority OK' : 'NO MAJORITY'}</small>
          </h3>
          {d.etcd.members.map((m) => (
            <div key={m.host} className={`inst ${m.up ? '' : 'down'}`}>
              <span className="name">
                <span className={`dot ${m.up ? '' : 'bad'}`} />
                {m.host.replace('http://', '')}
              </span>
              <span>{m.up ? m.isLeader ? <span className="tag leader">Raft leader</span> : <span className="tag">follower</span> : <span className="tag bad">down</span>}</span>
              {m.up && <span className="sub num">term {m.raftTerm}, index {m.raftIndex.toLocaleString()}, {m.ms} ms</span>}
            </div>
          ))}
          {!leaderMember && <div className="error-box" style={{ marginTop: 6 }}>No Raft leader: new leader elections are impossible until a majority is back.</div>}
        </section>

        <section className="card span-6">
          <h3>
            Answers per second <small>into the Redis Stream</small>
          </h3>
          <Chart series={[{ name: 'answers/s', values: h.answers, color: 'var(--amber)' }]} />
        </section>
        <section className="card span-6">
          <h3>
            Question fan-out <small>engine publish → last local socket written</small>
          </h3>
          <Chart series={[{ name: 'slowest gateway', values: h.fanout, color: 'var(--opt-d)' }]} unit=" ms" />
        </section>

        <section className="card span-4">
          <h3>Alerts <small>from Prometheus</small></h3>
          {d.alerts == null && <p className="muted">Prometheus is not reachable.</p>}
          {d.alerts?.length === 0 && <p className="muted">Nothing firing.</p>}
          {d.alerts?.map((a, i) => (
            <div key={i} className="inst" style={{ borderColor: a.state === 'firing' ? 'var(--bad)' : 'var(--warn)' }}>
              <span className="name">{a.name}</span>
              <span className={`tag ${a.state === 'firing' ? 'bad' : 'warn'}`}>{a.state}</span>
              <span className="sub">{a.summary}</span>
            </div>
          ))}
        </section>
        <section className="card span-4">
          <h3>Authentication</h3>
          <dl className="kv">
            <dt>Sign-ins</dt>
            <dd className="num">{auth.logins} ({auth.failed} failed)</dd>
            <dt>WebSocket tickets</dt>
            <dd className="num">{auth.tickets.toLocaleString()}</dd>
            <dt>Stolen refresh tokens caught</dt>
            <dd className="num" style={{ color: auth.reuse ? 'var(--bad)' : undefined }}>{auth.reuse}</dd>
            <dt>Signing key</dt>
            <dd className="mono">{auth.kid}</dd>
            <dt>Active sessions</dt>
            <dd className="num">{d.postgres?.sessions ?? '–'}</dd>
          </dl>
        </section>
        <section className="card span-4">
          <h3>Data</h3>
          <dl className="kv">
            <dt>Read replica</dt>
            <dd>{d.postgres?.replica_connected ? `streaming, ${Math.round(d.postgres.replica_lag_ms || 0)} ms behind` : 'not connected'}</dd>
            <dt>Finished games</dt>
            <dd className="num">{d.postgres?.finished ?? '–'}</dd>
            <dt>Accounts</dt>
            <dd className="num">{d.postgres?.users ?? '–'}</dd>
            <dt>API servers</dt>
            <dd>{d.lobbies.map((l) => l.instance).join(', ')}</dd>
            <dt>Auth servers</dt>
            <dd>{d.auths.map((l) => l.instance).join(', ')}</dd>
          </dl>
        </section>
      </div>
    </main>
  );
}
