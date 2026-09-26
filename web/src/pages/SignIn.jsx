import { useState } from 'react';
import { login, signup } from '../api.js';

const DEMO = [
  { label: 'Asha (player)', email: 'asha@buzzarena.dev', password: 'play-asha-2026' },
  { label: 'Kabir (player)', email: 'kabir@buzzarena.dev', password: 'play-kabir-2026' },
  { label: 'Meera (host)', email: 'meera@buzzarena.dev', password: 'host-meera-2026' },
  { label: 'Anita (admin)', email: 'admin@buzzarena.dev', password: 'arena-admin-2026' },
];

export default function SignIn({ next = '/' }) {
  const [mode, setMode] = useState('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'in') await login(email, password);
      else await signup(name, email, password);
      location.hash = `#${next === '/signin' ? '/' : next}`;
    } catch (err) {
      setError(err.retryAfter ? `${err.message} (try again in ${err.retryAfter} s)` : err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <div className="signin">
        <section className="signin-hero">
          <h1>Ten seconds. Four answers. Everyone at once.</h1>
          <p className="sub">A live quiz show for thousands of players. Questions reach every phone together, answers are judged by the server clock, and the game keeps going when a server dies.</p>
          <div className="hero-tiles" aria-hidden="true">
            <div style={{ background: 'var(--opt-a)' }}><b>A</b> Raft</div>
            <div style={{ background: 'var(--opt-b)' }}><b>B</b> Paxos</div>
            <div style={{ background: 'var(--opt-c)' }}><b>C</b> Gossip</div>
            <div style={{ background: 'var(--opt-d)' }}><b>D</b> 2PC</div>
          </div>
        </section>

        <section className="panel stack">
          <div className="tabs" role="tablist">
            <button className={mode === 'in' ? 'on' : ''} onClick={() => setMode('in')} role="tab" aria-selected={mode === 'in'}>
              Sign in
            </button>
            <button className={mode === 'up' ? 'on' : ''} onClick={() => setMode('up')} role="tab" aria-selected={mode === 'up'}>
              Create account
            </button>
          </div>
          <form className="stack" onSubmit={submit}>
            {mode === 'up' && (
              <label className="field">
                Display name
                <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="nickname" required minLength={2} maxLength={40} />
              </label>
            )}
            <label className="field">
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
            </label>
            <label className="field">
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'in' ? 'current-password' : 'new-password'} required minLength={8} />
            </label>
            {error && <div className="error-box">{error}</div>}
            <button className="btn big" disabled={busy}>
              {mode === 'in' ? 'Sign in' : 'Create account'}
            </button>
          </form>
          {mode === 'in' && (
            <div className="stack" style={{ gap: 8 }}>
              <span className="muted" style={{ fontSize: '0.9rem' }}>Demo accounts (fill the form):</span>
              <div className="demo-accounts">
                {DEMO.map((d) => (
                  <button
                    key={d.email}
                    className="chip"
                    type="button"
                    onClick={() => {
                      setEmail(d.email);
                      setPassword(d.password);
                    }}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
