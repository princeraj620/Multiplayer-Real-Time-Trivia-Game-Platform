import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useSession } from '../App.jsx';
import UnderTheHood from '../components/UnderTheHood.jsx';

export default function Admin() {
  const session = useSession();
  const [users, setUsers] = useState([]);
  const [audit, setAudit] = useState([]);
  const [packs, setPacks] = useState([]);
  const [packId, setPackId] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [msg, setMsg] = useState(null);
  const [error, setError] = useState(null);

  const load = async () => {
    const [u, a, p] = await Promise.all([api('GET', '/api/admin/users'), api('GET', '/api/admin/audit'), api('GET', '/api/packs')]);
    setUsers(u.users);
    setAudit(a.audit);
    setPacks(p.packs);
    if (!packId && p.packs[0]) setPackId(p.packs[0].id);
  };
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (packId) api('GET', `/api/packs/${packId}/questions`).then((r) => setQuestions(r.questions)).catch((e) => setError(e.message));
  }, [packId]);

  async function setRole(id, role) {
    try {
      await api('PATCH', `/api/admin/users/${id}/role`, { role });
      setMsg('Role changed. That user is signed out everywhere and gets the new role at their next sign-in.');
      await load();
    } catch (e) {
      setError(e.message);
    }
  }
  async function rotate() {
    try {
      const r = await api('POST', '/api/auth/keys/rotate');
      setMsg(`New signing key ${r.kid}. Tokens signed with the old key keep working until they expire.`);
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <main className="page">
      <div className="row between wrap" style={{ marginBottom: 20 }}>
        <h1>Admin</h1>
        <button className="btn ghost" onClick={rotate}>Rotate the token signing key</button>
      </div>
      {msg && <div className="note-box" style={{ marginBottom: 14 }}>{msg}</div>}
      {error && <div className="error-box" style={{ marginBottom: 14 }}>{error}</div>}
      <div className="grid-2">
        <section className="panel">
          <h2 style={{ marginBottom: 12 }}>People and roles</h2>
          <table className="plain">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td className="muted">{u.email}</td>
                  <td>
                    <select value={u.role} disabled={u.id === session.user?.id} onChange={(e) => setRole(u.id, e.target.value)} style={{ padding: '4px 8px' }}>
                      <option value="player">player</option>
                      <option value="host">host</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="panel">
          <h2 style={{ marginBottom: 12 }}>Security log</h2>
          <table className="plain">
            <tbody>
              {audit.slice(0, 14).map((a, i) => (
                <tr key={i}>
                  <td className="muted num" style={{ whiteSpace: 'nowrap' }}>{new Date(a.at).toLocaleTimeString()}</td>
                  <td>
                    <b>{a.action.replaceAll('_', ' ')}</b>
                    <div className="muted" style={{ fontSize: '0.82rem' }}>
                      {a.actor || 'system'} {a.target ? `on ${String(a.target).slice(0, 18)}` : ''}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <section className="panel" style={{ marginTop: 24 }}>
        <div className="row between wrap" style={{ marginBottom: 12 }}>
          <h2>Question bank</h2>
          <select value={packId || ''} onChange={(e) => setPackId(Number(e.target.value))} style={{ width: 'auto' }}>
            {packs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.emoji} {p.title}
              </option>
            ))}
          </select>
        </div>
        <p className="muted" style={{ marginBottom: 12, fontSize: '0.92rem' }}>
          Correct answers are stored encrypted (AES-256-GCM). Only the game engine, at the deadline, and admins can decrypt them.
        </p>
        <table className="plain">
          <thead>
            <tr>
              <th>Question</th>
              <th>Answer</th>
              <th>Stored in the database as</th>
            </tr>
          </thead>
          <tbody>
            {questions.map((q) => (
              <tr key={q.id}>
                <td>{q.text}</td>
                <td style={{ fontWeight: 700 }}>{q.options[q.correct]}</td>
                <td className="mono muted">{q.ciphertext}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <UnderTheHood />
    </main>
  );
}
