import { useEffect, useState } from 'react';
import { requestLog } from '../api.js';

const JAEGER = 'http://localhost:16686';

/** The teaching panel: what the system did for you, request by request and message by message. */
export default function UnderTheHood({ socket, game }) {
  const [open, setOpen] = useState(() => sessionStorage.getItem('hood') === '1');
  const [, tick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => tick((x) => x + 1), 500);
    return () => clearInterval(t);
  }, [open]);
  const toggle = () => {
    sessionStorage.setItem('hood', open ? '0' : '1');
    setOpen(!open);
  };

  return (
    <>
      <button className="btn ghost small hood-toggle" onClick={toggle} aria-expanded={open}>
        {open ? 'Close' : 'Under the hood'}
      </button>
      {open && (
        <aside className="hood" aria-label="Under the hood">
          {socket && (
            <>
              <h3>Your connection</h3>
              <div className="kv">
                <dt>Gateway</dt>
                <dd>
                  <span className={`dot ${socket.status === 'open' ? '' : 'warn'}`} />
                  {socket.gateway || '…'} ({socket.status})
                </dd>
                <dt>Round trip</dt>
                <dd className="num">{socket.rtt != null ? `${socket.rtt} ms` : '…'}</dd>
                <dt>Clock offset</dt>
                <dd className="num">{Math.round(socket.offset)} ms (server − this device)</dd>
                <dt>Last message</dt>
                <dd className="num">#{socket.lastSeq}</dd>
                <dt>Reconnects</dt>
                <dd className="num">{socket.reconnects}</dd>
              </div>
            </>
          )}
          {game?.leader && (
            <>
              <h3>Game leader</h3>
              <div className="kv">
                <dt>Engine</dt>
                <dd>{game.leader}</dd>
                <dt>Fencing token</dt>
                <dd className="num">{game.token}</dd>
              </div>
            </>
          )}
          {game?.answers?.length > 0 && (
            <>
              <h3>Your answers, traced</h3>
              <div className="log">
                {game.answers.slice(0, 6).map((a) => (
                  <div key={`${a.q}-${a.recvAt}`}>
                    <span>Q{a.q + 1}</span>
                    <span>{a.status}</span>
                    {a.traceId ? (
                      <a href={`${JAEGER}/trace/${a.traceId}`} target="_blank" rel="noreferrer">
                        trace {a.traceId.slice(0, 12)}
                      </a>
                    ) : (
                      <span className="dim">not sampled</span>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
          {socket && (
            <>
              <h3>Messages from the game</h3>
              <div className="log">
                {socket.log.slice(0, 12).map((m, i) => (
                  <div key={i}>
                    <span className="dim">{m.seq ? `#${m.seq}` : ''}</span>
                    <span>{m.type}</span>
                    <span className="muted">{m.detail}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          <h3>API requests</h3>
          <div className="log">
            {requestLog.slice(0, 10).map((r, i) => (
              <div key={i} style={{ gridTemplateColumns: '38px 1fr auto' }}>
                <span className={r.status >= 400 ? '' : 'dim'} style={{ color: r.status >= 400 ? 'var(--bad)' : undefined }}>
                  {r.status}
                </span>
                <span>
                  {r.method} {r.path.replace(/[0-9a-f-]{36}/, ':id')}
                </span>
                <span className="muted">
                  {r.servedBy || ''} {r.readFrom ? `(${r.readFrom})` : ''} {r.ms}ms
                </span>
              </div>
            ))}
          </div>
        </aside>
      )}
    </>
  );
}
