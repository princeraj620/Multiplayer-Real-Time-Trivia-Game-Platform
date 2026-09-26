import { useEffect, useState } from 'react';
import { api } from '../api.js';
import UnderTheHood from '../components/UnderTheHood.jsx';

const LETTERS = ['A', 'B', 'C', 'D'];
const COLORS = ['var(--opt-a)', 'var(--opt-b)', 'var(--opt-c)', 'var(--opt-d)'];
const PHASES = ['LOBBY', 'COUNTDOWN', 'QUESTION', 'LOCKED', 'REVEAL', 'LEADERBOARD', 'FINISHED'];

export default function HostConsole({ gameId }) {
  const [v, setV] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api('GET', `/api/games/${gameId}/host`)
        .then((r) => alive && (setV(r), setError(null)))
        .catch((e) => alive && setError(e.message));
    load();
    const t = setInterval(load, 700);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [gameId]);

  async function start() {
    setBusy(true);
    try {
      await api('POST', `/api/games/${gameId}/start`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!v) return <main className="page">{error ? <div className="error-box">{error}</div> : <p className="muted">Loading…</p>}</main>;
  const { game, state, question, dist, answered, players, survivors } = v;
  const total = Math.max(1, dist.reduce((a, b) => a + b, 0));
  const secsLeft = state.phase === 'QUESTION' ? Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000)) : null;

  return (
    <main className="page">
      <div className="row between wrap" style={{ marginBottom: 20 }}>
        <div>
          <h1>{game.title}</h1>
          <p className="muted" style={{ marginTop: 6 }}>Host console. Players never see the correct answer before the reveal; you do.</p>
        </div>
        <div className="row">
          {game.status === 'SCHEDULED' && (
            <button className="btn big" onClick={start} disabled={busy}>
              Start the game
            </button>
          )}
          {game.status === 'LIVE' && <span className="onair">On air</span>}
          <a className="btn ghost" href={`#/game/${gameId}`}>Player view</a>
        </div>
      </div>
      {error && <div className="error-box" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="host-grid">
        <section className="panel">
          <div className="phase-track" style={{ marginBottom: 18 }} aria-label={`Phase ${state.phase}`}>
            {PHASES.map((p, i) => (
              <span key={p} title={p} className={p === state.phase ? 'now' : PHASES.indexOf(state.phase) > i ? 'done' : ''} />
            ))}
          </div>
          {state.phase === 'LOBBY' ? (
            <div className="waiting" style={{ padding: 30 }}>
              <div className="huge">{players}</div>
              <p className="muted">players waiting in the lobby</p>
            </div>
          ) : question ? (
            <>
              <div className="row between">
                <span className="qnum">Question {question.index + 1} of {game.total}</span>
                <span className="muted num">{state.phase === 'QUESTION' ? `${secsLeft} s left` : state.phase.toLowerCase()}</span>
              </div>
              <div className="qtext" style={{ marginBottom: 18 }}>{question.text}</div>
              {question.options.map((o, i) => (
                <div key={i} className="dist-row">
                  <span className="rank" style={{ background: COLORS[i], color: 'var(--stage)' }}>{LETTERS[i]}</span>
                  <div>
                    <div className="row between" style={{ marginBottom: 4, fontWeight: 600 }}>
                      <span>
                        {o} {i === question.correct && <span className="tag ok">correct</span>}
                      </span>
                    </div>
                    <div className="dist-track">
                      <div className="dist-fill" style={{ width: `${(dist[i] / total) * 100}%`, background: COLORS[i] }} />
                    </div>
                  </div>
                  <span className="num" style={{ textAlign: 'right', fontWeight: 700 }}>{dist[i]}</span>
                </div>
              ))}
            </>
          ) : null}
        </section>

        <aside className="stack">
          <section className="panel">
            <h3 style={{ marginBottom: 12 }}>Live numbers</h3>
            <dl className="kv">
              <dt>Players</dt>
              <dd className="num">{players.toLocaleString()}</dd>
              <dt>Answered this question</dt>
              <dd className="num">{answered.toLocaleString()}</dd>
              <dt>Still in</dt>
              <dd className="num">{survivors.toLocaleString()}</dd>
              <dt>Answers in the stream</dt>
              <dd className="num">{v.answersInStream.toLocaleString()}</dd>
            </dl>
          </section>
          <section className="panel">
            <h3 style={{ marginBottom: 12 }}>Who runs this game</h3>
            <dl className="kv">
              <dt>Leader engine</dt>
              <dd>{state.leader || 'none yet'}</dd>
              <dt>Fencing token</dt>
              <dd className="num">{state.token || '–'}</dd>
              <dt>Messages sent</dt>
              <dd className="num">{state.seq}</dd>
            </dl>
            <p className="muted" style={{ marginTop: 10, fontSize: '0.88rem' }}>
              Stop the leader (<span className="mono">docker compose kill {state.leader ? state.leader.replace('-', '') : 'engine1'}</span>) and another engine takes over within about 5 seconds.
            </p>
          </section>
        </aside>
      </div>
      <UnderTheHood game={{ leader: state.leader, token: state.token }} />
    </main>
  );
}
