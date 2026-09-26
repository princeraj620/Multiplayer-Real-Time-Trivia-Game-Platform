import { useEffect, useState } from 'react';
import { getSession, onSession, refresh, logout } from './api.js';
import SignIn from './pages/SignIn.jsx';
import Lobby from './pages/Lobby.jsx';
import Game from './pages/Game.jsx';
import HostHome from './pages/HostHome.jsx';
import HostConsole from './pages/HostConsole.jsx';
import Admin from './pages/Admin.jsx';
import Dashboard from './pages/Dashboard.jsx';

function useHash() {
  const [hash, setHash] = useState(location.hash.slice(1) || '/');
  useEffect(() => {
    const on = () => setHash(location.hash.slice(1) || '/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export function useSession() {
  const [s, setS] = useState(getSession());
  useEffect(() => onSession(setS), []);
  return s;
}

function TopBar({ session, route }) {
  const user = session.user;
  const link = (href, label) => (
    <a href={`#${href}`} className={route === href || (href !== '/' && route.startsWith(href)) ? 'active' : ''}>
      {label}
    </a>
  );
  return (
    <header className="topbar">
      <a className="brand" href="#/">
        <span className="brand-dot" aria-hidden="true" /> BuzzArena
      </a>
      <nav className="nav">
        {user && link('/', 'Games')}
        {user && (user.role === 'host' || user.role === 'admin') && link('/host', 'Host')}
        {user?.role === 'admin' && link('/admin', 'Admin')}
        {link('/dashboard', 'Dashboard')}
      </nav>
      {user && (
        <div className="who">
          <span>{user.name}</span>
          <span className={`role ${user.role}`}>{user.role}</span>
          <button className="btn ghost small" onClick={() => logout().then(() => (location.hash = '#/signin'))}>
            Sign out
          </button>
        </div>
      )}
    </header>
  );
}

export default function App() {
  const route = useHash();
  const session = useSession();
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    refresh()
      .catch(() => {})
      .finally(() => setBooted(true));
  }, []);

  if (!booted) return <div className="page muted">Loading…</div>;

  const needsLogin = !session.user && !route.startsWith('/dashboard') && !route.startsWith('/signin');
  if (needsLogin) {
    return (
      <>
        <TopBar session={session} route={route} />
        <SignIn next={route} />
      </>
    );
  }

  let page;
  const parts = route.split('/').filter(Boolean);
  if (route.startsWith('/signin')) page = <SignIn next="/" />;
  else if (parts[0] === 'game') page = <Game gameId={parts[1]} key={parts[1]} />;
  else if (parts[0] === 'host' && parts[1]) page = <HostConsole gameId={parts[1]} key={parts[1]} />;
  else if (parts[0] === 'host') page = <HostHome />;
  else if (parts[0] === 'admin') page = <Admin />;
  else if (parts[0] === 'dashboard') page = <Dashboard />;
  else page = <Lobby />;

  return (
    <>
      <TopBar session={session} route={route} />
      {page}
    </>
  );
}
