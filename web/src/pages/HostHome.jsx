import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useSession } from '../App.jsx';
import UnderTheHood from '../components/UnderTheHood.jsx';

export default function HostHome() {
  const session = useSession();
  const [packs, setPacks] = useState([]);
  const [games, setGames] = useState([]);
  const [form, setForm] = useState({ title: '', packId: '', questionCount: 8, questionSec: 10 });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const [p, g] = await Promise.all([api('GET', '/api/packs'), api('GET', '/api/games?status=all')]);
    setPacks(p.packs);
    setGames(g.games.filter((x) => x.host_id === session.user?.id || session.user?.role === 'admin'));
    setForm((f) => (f.packId ? f : { ...f, packId: p.packs[0]?.id }));
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  async function create(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api('POST', '/api/games', { ...form, packId: Number(form.packId), questionCount: Number(form.questionCount), questionSec: Number(form.questionSec) });
      location.hash = `#/host/${r.game.id}`;
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <h1 style={{ marginBottom: 22 }}>Host a game</h1>
      <div className="grid-2">
        <section className="panel">
          <form className="stack" onSubmit={create}>
            <label className="field">
              Title
              <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Hostel Quiz Night" required minLength={3} maxLength={60} />
            </label>
            <label className="field">
              Question pack
              <select value={form.packId} onChange={(e) => setForm({ ...form, packId: e.target.value })}>
                {packs.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.emoji} {p.title} ({p.questions} questions)
                  </option>
                ))}
              </select>
            </label>
            <div className="row">
              <label className="field" style={{ flex: 1 }}>
                Questions
                <input type="number" min={2} max={20} value={form.questionCount} onChange={(e) => setForm({ ...form, questionCount: e.target.value })} />
              </label>
              <label className="field" style={{ flex: 1 }}>
                Seconds per question
                <input type="number" min={5} max={60} value={form.questionSec} onChange={(e) => setForm({ ...form, questionSec: e.target.value })} />
              </label>
            </div>
            {error && <div className="error-box">{error}</div>}
            <button className="btn" disabled={busy}>Create game</button>
          </form>
        </section>
        <section className="stack">
          <h2>Your games</h2>
          {games.length === 0 && <p className="muted">No games yet.</p>}
          {games.map((g) => (
            <a key={g.id} className={`show ${g.status === 'LIVE' ? 'live' : ''}`} href={g.status === 'FINISHED' ? `#/game/${g.id}` : `#/host/${g.id}`}>
              <div className="emoji" aria-hidden="true">{g.pack_emoji}</div>
              <div>
                <h3>{g.title}</h3>
                <div className="meta">{g.status.toLowerCase()}, {g.players} players</div>
              </div>
              <span className="muted">{g.status === 'FINISHED' ? 'Results' : 'Open console'}</span>
            </a>
          ))}
        </section>
      </div>
      <UnderTheHood />
    </main>
  );
}
