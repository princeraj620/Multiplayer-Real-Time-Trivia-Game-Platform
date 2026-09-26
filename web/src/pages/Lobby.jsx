import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useSession } from '../App.jsx';
import UnderTheHood from '../components/UnderTheHood.jsx';

function when(ts) {
  const d = new Date(ts);
  const mins = Math.round((d - Date.now()) / 60000);
  if (mins > 0 && mins < 180) return `in ${mins} min`;
  if (mins <= 0 && mins > -180) return `${-mins} min ago`;
  return d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function ShowRow({ g }) {
  const live = g.status === 'LIVE';
  return (
    <a className={`show ${live ? 'live' : ''}`} href={`#/game/${g.id}`}>
      <div className="emoji" aria-hidden="true">{g.pack_emoji}</div>
      <div>
        <div className="row" style={{ gap: 10 }}>
          <h3>{g.title}</h3>
          {live && <span className="onair">On air</span>}
        </div>
        <div className="meta">
          Hosted by {g.host_name}, {g.question_count} questions of {g.question_sec} s, {live ? (g.live?.phase === 'QUESTION' ? `question ${g.live.q + 1} now` : 'playing now') : new Date(g.scheduled_at) < Date.now() ? 'waiting for the host to start' : `starts ${when(g.scheduled_at)}`}
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div className="num" style={{ fontFamily: 'var(--display)', fontWeight: 800, fontSize: '1.5rem' }}>{g.players}</div>
        <div className="muted" style={{ fontSize: '0.8rem' }}>{live ? 'playing' : 'in the lobby'}</div>
      </div>
    </a>
  );
}

export default function Lobby() {
  const session = useSession();
  const [games, setGames] = useState(null);
  const [finished, setFinished] = useState([]);
  const [board, setBoard] = useState([]);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const [g, f, lb, h] = await Promise.all([api('GET', '/api/games'), api('GET', '/api/games?status=finished'), api('GET', '/api/leaderboard'), api('GET', '/api/me/history')]);
        if (!alive) return;
        setGames(g.games);
        setFinished(f.games.slice(0, 5));
        setBoard(lb.leaderboard.slice(0, 8));
        setHistory(h.history.slice(0, 5));
        setError(null);
      } catch (err) {
        if (alive) setError(err.message);
      }
    }
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <main className="page">
      <div className="lobby-head">
        <div>
          <h1>Tonight's games</h1>
          <p className="muted" style={{ marginTop: 8 }}>Join a lobby before the host starts. Once a game is on air, new arrivals can only watch.</p>
        </div>
      </div>
      {error && <div className="error-box" style={{ marginBottom: 16 }}>{error}</div>}
      <div className="grid-2">
        <section className="show-list">
          {games === null && <p className="muted">Loading games…</p>}
          {games?.length === 0 && <div className="panel muted">No games scheduled. A host can create one from the Host page.</div>}
          {games?.map((g) => <ShowRow key={g.id} g={g} />)}

          {finished.length > 0 && (
            <>
              <h2 style={{ marginTop: 26 }}>Recent results</h2>
              {finished.map((g) => (
                <a key={g.id} className="show" href={`#/game/${g.id}`} style={{ gridTemplateColumns: '64px 1fr auto' }}>
                  <div className="emoji" aria-hidden="true">{g.pack_emoji}</div>
                  <div>
                    <h3>{g.title}</h3>
                    <div className="meta">
                      {g.player_count} players, {g.survivor_count} answered everything right, {when(g.finished_at)}
                    </div>
                  </div>
                  <span className="muted">Results</span>
                </a>
              ))}
            </>
          )}
        </section>

        <aside className="stack">
          <section className="panel">
            <h2 style={{ marginBottom: 12 }}>All-time leaders</h2>
            <table className="lb-table">
              <tbody>
                {board.map((r, i) => (
                  <tr key={r.id}>
                    <td>
                      <span className={`rank ${i === 0 ? 'r1' : ''}`}>{i + 1}</span>
                      {r.name}
                      {r.id === session.user?.id && <span className="muted"> (you)</span>}
                    </td>
                    <td className="muted" style={{ fontWeight: 500 }}>{r.wins ? `${r.wins} win${r.wins > 1 ? 's' : ''}` : ''}</td>
                    <td>{r.total.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="panel">
            <h2 style={{ marginBottom: 12 }}>Your last games</h2>
            {history.length === 0 && <p className="muted">Nothing yet. Join a lobby and play one.</p>}
            <table className="lb-table">
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td>
                      {h.title}
                      <div className="muted" style={{ fontSize: '0.82rem' }}>
                        {h.correct_count} of {h.question_count} right, rank {h.rank} of {h.player_count}
                      </div>
                    </td>
                    <td />
                    <td>{h.score.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </aside>
      </div>
      <UnderTheHood />
    </main>
  );
}
