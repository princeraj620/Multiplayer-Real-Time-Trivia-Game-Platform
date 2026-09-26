import { useEffect, useReducer, useRef, useState } from 'react';
import { api } from '../api.js';
import { GameSocket } from '../ws.js';
import { useSession } from '../App.jsx';
import UnderTheHood from '../components/UnderTheHood.jsx';

const LETTERS = ['A', 'B', 'C', 'D'];
const OPT = ['opt-a', 'opt-b', 'opt-c', 'opt-d'];

const initial = { phase: 'CONNECTING', players: 0, you: { score: 0, rank: null, alive: true }, answers: [], top: [], toast: null };

function reducer(s, m) {
  switch (m.type) {
    case 'joined':
      return { ...s, title: m.title, total: m.total, hostName: m.hostName, spectator: m.spectator, phase: s.phase === 'CONNECTING' ? m.phase : s.phase, players: m.players, you: { ...s.you, ...m.you }, leader: m.leader || s.leader, token: m.token || s.token, myChoice: m.you.answered ?? s.myChoice, error: null };
    case 'presence':
      return { ...s, players: m.players };
    case 'leader':
      return { ...s, leader: m.engine, token: m.token, toast: m.resumed ? { text: `${m.engine} took over the game (fencing token ${m.token}) after ${(m.silenceMs / 1000).toFixed(1)} s. Nothing was lost.`, at: Date.now() } : s.toast };
    case 'countdown':
      return { ...s, phase: 'COUNTDOWN', startsAt: m.startsAt, total: m.total, players: m.players };
    case 'question':
      return { ...s, phase: 'QUESTION', question: m, myChoice: s.question?.q === m.q ? s.myChoice : null, pending: null, reveal: null, answered: 0, lastAck: null };
    case 'tally':
      return s.question && m.q === s.question.q ? { ...s, answered: m.answered } : s;
    case 'answer_ack': {
      const answers = [m, ...s.answers.filter((a) => a.q !== m.q || m.status !== 'RECEIVED')];
      if (m.status === 'RECEIVED') return { ...s, myChoice: m.choice, pending: null, lastAck: m, answers };
      if (m.status === 'ALREADY_ANSWERED') return { ...s, myChoice: m.choice, pending: null, lastAck: m };
      return { ...s, pending: null, lastAck: m, answers };
    }
    case 'locked':
      return { ...s, phase: 'LOCKED' };
    case 'reveal':
      return { ...s, phase: 'REVEAL', reveal: m, survivors: m.survivors, players: m.players };
    case 'you':
      return { ...s, you: { ...s.you, ...m }, myChoice: m.after === 'reveal' && m.choice != null ? m.choice : s.myChoice };
    case 'leaderboard':
      return { ...s, phase: 'LEADERBOARD', top: m.top, survivors: m.survivors, players: m.players, isLast: m.isLast };
    case 'finished':
      return { ...s, phase: 'FINISHED', top: m.top, survivors: m.survivors, players: m.players };
    case 'error':
      return { ...s, error: m.message, errorCode: m.code };
    case 'pending':
      return { ...s, pending: m.choice };
    case 'clear-toast':
      return { ...s, toast: null };
    default:
      return s;
  }
}

function useNow(socket, active) {
  const [now, setNow] = useState(() => socket?.now() ?? Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(socket.now()), 100);
    return () => clearInterval(t);
  }, [socket, active]);
  return now;
}

function Ring({ remainingMs, totalMs }) {
  const r = 50;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, remainingMs / totalMs));
  const secs = Math.ceil(remainingMs / 1000);
  return (
    <div className={`ring ${secs <= 3 ? 'urgent' : ''}`} role="timer" aria-label={`${secs} seconds left`}>
      <svg viewBox="0 0 116 116" width="100%" height="100%">
        <circle cx="58" cy="58" r={r} fill="none" stroke="var(--line)" strokeWidth="9" />
        <circle cx="58" cy="58" r={r} fill="none" stroke={secs <= 3 ? 'var(--opt-a)' : 'var(--amber)'} strokeWidth="9" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - frac)} style={{ transition: 'stroke-dashoffset 0.1s linear' }} />
      </svg>
      <div className="count">{Math.max(0, secs)}</div>
    </div>
  );
}

function Board({ top, me, you }) {
  const inTop = top.some((t) => t.id === me);
  return (
    <div className="board">
      {top.map((t) => (
        <div key={t.id} className={`board-row ${t.id === me ? 'me' : ''}`}>
          <span className={`rank ${t.rank === 1 ? 'r1' : ''}`}>{t.rank}</span>
          <span style={{ fontWeight: 700 }}>{t.name}</span>
          <span className="muted num">{t.correct} right</span>
          <span className="score">{t.score.toLocaleString()}</span>
        </div>
      ))}
      {!inTop && you?.rank && (
        <div className="board-row me">
          <span className="rank">{you.rank}</span>
          <span style={{ fontWeight: 700 }}>You</span>
          <span />
          <span className="score">{(you.score || 0).toLocaleString()}</span>
        </div>
      )}
    </div>
  );
}

function Results({ gameId }) {
  const [data, setData] = useState(null);
  const session = useSession();
  useEffect(() => {
    api('GET', `/api/games/${gameId}/results`).then(setData).catch(() => setData({ error: true }));
  }, [gameId]);
  if (!data) return <p className="muted">Loading results…</p>;
  if (data.error) return <div className="error-box">This game has no results yet.</div>;
  const top = data.top.map((r) => ({ id: r.user_id, name: r.name, rank: r.rank, score: r.score, correct: r.correct_count }));
  return (
    <div>
      <h1>{data.game.title}</h1>
      <p className="muted" style={{ margin: '8px 0 20px' }}>
        Final results: {data.game.player_count} players, {data.game.survivor_count} answered every question right.
      </p>
      <Podium top={top} />
      <Board top={top} me={session.user?.id} />
    </div>
  );
}

function Podium({ top }) {
  const [a, b, c] = top;
  if (!a) return null;
  return (
    <div className="podium">
      <div className="p2">{b && <><div className="rank">2</div><div className="name">{b.name}</div><div className="num">{b.score.toLocaleString()}</div></>}</div>
      <div className="p1"><div style={{ fontSize: '2rem' }} aria-hidden="true">🏆</div><div className="name">{a.name}</div><div className="num">{a.score.toLocaleString()}</div></div>
      <div className="p3">{c && <><div className="rank">3</div><div className="name">{c.name}</div><div className="num">{c.score.toLocaleString()}</div></>}</div>
    </div>
  );
}

export default function Game({ gameId }) {
  const session = useSession();
  const [s, dispatch] = useReducer(reducer, initial);
  const [game, setGame] = useState(null);
  const [, bump] = useState(0);
  const socketRef = useRef(null);

  useEffect(() => {
    api('GET', `/api/games/${gameId}`).then((r) => setGame(r.game)).catch(() => setGame({ missing: true }));
  }, [gameId]);

  useEffect(() => {
    if (!game || game.missing || game.status === 'FINISHED' || game.status === 'CANCELLED') return;
    const sock = new GameSocket(dispatch, () => bump((x) => x + 1));
    socketRef.current = sock;
    sock.start(gameId).catch((err) => dispatch({ type: 'error', message: err.message }));
    return () => sock.stop();
  }, [game, gameId]);

  useEffect(() => {
    if (!s.toast) return;
    const t = setTimeout(() => dispatch({ type: 'clear-toast' }), 7000);
    return () => clearTimeout(t);
  }, [s.toast]);

  const socket = socketRef.current;
  const ticking = ['QUESTION', 'COUNTDOWN', 'LOCKED'].includes(s.phase);
  const now = useNow(socket, ticking && !!socket);

  function choose(i) {
    if (s.spectator || s.phase !== 'QUESTION' || s.myChoice != null || s.pending != null) return;
    if (socket?.answer(s.question.q, i)) dispatch({ type: 'pending', choice: i });
  }

  useEffect(() => {
    const onKey = (e) => {
      const idx = { 1: 0, 2: 1, 3: 2, 4: 3, a: 0, b: 1, c: 2, d: 3 }[e.key.toLowerCase()];
      if (idx !== undefined && s.question && idx < s.question.options.length) choose(idx);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!game) return <main className="stage muted">Loading…</main>;
  if (game.missing) return <main className="stage"><div className="error-box">This game does not exist.</div></main>;
  if (game.status === 'FINISHED' || (s.phase === 'CONNECTING' && s.errorCode === 'NO_SUCH_GAME')) {
    return (
      <main className="stage">
        <Results gameId={gameId} />
      </main>
    );
  }

  const q = s.question;
  const remaining = q ? q.deadline - now : 0;
  const status = (
    <div className="status-pills">
      <span className="pill num">{s.players} players</span>
      {s.spectator ? <span className="pill spect">Watching</span> : s.you.alive ? <span className="pill alive">Still in</span> : <span className="pill out">Knocked out</span>}
      {!s.spectator && <span className="pill num">{(s.you.score || 0).toLocaleString()} pts{s.you.rank ? `, #${s.you.rank}` : ''}</span>}
    </div>
  );

  let body;
  if (s.phase === 'CONNECTING') {
    body = <div className="waiting"><p className="muted">Connecting to a game server…</p></div>;
  } else if (s.phase === 'LOBBY') {
    body = (
      <div className="waiting">
        <div className="huge">{s.players}</div>
        <p className="muted" style={{ marginBottom: 24 }}>players in the lobby</p>
        <h1>{s.spectator ? 'You are watching this game' : "You're in"}</h1>
        <p className="muted">{s.hostName ? `${s.hostName} starts the game soon.` : 'The host starts the game soon.'} Answer fast: quicker right answers score more (500 to 1,000 points).</p>
      </div>
    );
  } else if (s.phase === 'COUNTDOWN') {
    const secs = Math.max(0, Math.ceil((s.startsAt - now) / 1000));
    body = (
      <div className="waiting">
        <p className="muted">Question 1 of {s.total} in</p>
        <div className="huge">{secs}</div>
        <h1>{s.title}</h1>
      </div>
    );
  } else if (['QUESTION', 'LOCKED', 'REVEAL'].includes(s.phase) && q) {
    const rev = s.phase === 'REVEAL' ? s.reveal : null;
    const total = rev ? rev.dist.reduce((a, b) => a + b, 0) || 1 : 1;
    const chosen = s.myChoice ?? s.pending;
    body = (
      <>
        <div className="qhead">
          <div>
            <div className="qnum">Question {q.q + 1} of {q.total}</div>
            <div className="qtext">{q.text}</div>
          </div>
          {s.phase === 'QUESTION' ? (
            <Ring remainingMs={remaining} totalMs={q.questionMs} />
          ) : rev ? (
            <div className="ring answer-badge" aria-label={`Correct answer ${LETTERS[rev.correct]}`}>
              <div className="count">{LETTERS[rev.correct]}</div>
            </div>
          ) : (
            <div className="ring locked-badge" aria-label="Answers locked">
              <div className="count">0</div>
            </div>
          )}
        </div>
        <div className="options">
          {q.options.map((text, i) => {
            const cls = [OPT[i]];
            if (chosen === i) cls.push('chosen');
            if (rev) {
              if (i === rev.correct) cls.push('right');
              else if (chosen === i) cls.push('wrong');
              else cls.push('faded');
            } else if (chosen != null && chosen !== i) cls.push('faded');
            const pct = rev ? Math.round((rev.dist[i] / total) * 100) : null;
            return (
              <button key={i} className={`opt ${cls.join(' ')}`} onClick={() => choose(i)} disabled={s.spectator || s.phase !== 'QUESTION' || chosen != null} aria-pressed={chosen === i}>
                {rev && <span className="bar" style={{ width: `${pct}%` }} />}
                <span className="key">{LETTERS[i]}</span>
                <span>{text}</span>
                {rev && <span className="pct">{pct}%</span>}
              </button>
            );
          })}
        </div>
        {s.phase === 'QUESTION' && (
          <div className="banner">
            <span>{s.spectator ? 'You are watching.' : chosen != null ? `Locked in: ${LETTERS[chosen]}. Waiting for the others.` : 'Tap an answer, or press 1-4.'}</span>
            <span className="muted num">{s.answered || 0} answered</span>
          </div>
        )}
        {s.phase === 'LOCKED' && <div className="banner"><span>Time is up. Counting {s.answered || ''} answers…</span></div>}
        {rev && !s.spectator && (
          <div className={`banner ${s.you.after === 'reveal' && s.you.q === q.q ? (s.you.correct ? 'good' : 'bad') : ''}`}>
            <span className="big">{s.you.q === q.q ? (s.you.correct ? `+${s.you.points} points` : s.you.choice == null ? 'No answer this time' : 'Not this time') : 'Checking…'}</span>
            <span className="muted">{rev.correctCount.toLocaleString()} of {rev.players.toLocaleString()} got it right. {rev.survivors.toLocaleString()} still in.</span>
          </div>
        )}
        {rev?.fact && <p className="fact">{rev.fact}</p>}
        {s.lastAck && s.lastAck.status !== 'RECEIVED' && s.lastAck.q === q.q && s.lastAck.status !== 'ALREADY_ANSWERED' && (
          <div className="error-box" style={{ marginTop: 12 }}>Your answer was not accepted: {s.lastAck.status.replace('_', ' ').toLowerCase()}.</div>
        )}
      </>
    );
  } else if (s.phase === 'LEADERBOARD') {
    body = (
      <>
        <div className="row between wrap" style={{ margin: '6px 0 16px' }}>
          <h1>{s.isLast ? 'Final standings' : 'Leaderboard'}</h1>
          <span className="muted">{s.survivors} of {s.players} still in</span>
        </div>
        <Board top={s.top} me={session.user?.id} you={s.you} />
      </>
    );
  } else if (s.phase === 'FINISHED') {
    body = (
      <>
        <h1 style={{ marginTop: 6 }}>That's the game</h1>
        <p className="muted" style={{ marginTop: 8 }}>
          {s.survivors} of {s.players} players answered every question right.{!s.spectator && s.you.rank ? ` You finished #${s.you.rank} with ${(s.you.score || 0).toLocaleString()} points.` : ''}
        </p>
        <Podium top={s.top} />
        <Board top={s.top} me={session.user?.id} you={s.you} />
      </>
    );
  } else {
    body = <div className="waiting muted">Waiting for the game…</div>;
  }

  return (
    <main className="stage">
      <div className="stage-top">
        <div>
          <h2>{s.title || game.title}</h2>
          <span className="muted" style={{ fontSize: '0.9rem' }}>
            {socket?.status === 'reconnecting' ? 'Reconnecting… you will not miss anything' : socket?.gateway ? `Connected to ${socket.gateway}` : ''}
          </span>
        </div>
        {status}
      </div>
      {s.toast && <div className="note-box" style={{ marginBottom: 14 }}>{s.toast.text}</div>}
      {s.error && <div className="error-box" style={{ marginBottom: 14 }}>{s.error}</div>}
      {body}
      <UnderTheHood socket={socket} game={{ leader: s.leader, token: s.token, answers: s.answers }} />
    </main>
  );
}
