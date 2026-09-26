// Session handling in the browser.
//
// The access token (15 min) lives only in memory. The refresh token is an HttpOnly, Secure,
// SameSite=Strict cookie scoped to /api/auth, so JavaScript can never read it. On page load we
// ask /api/auth/refresh for a new access token (the cookie is sent automatically).

let session = { token: null, user: null, expiresAt: 0 };
const listeners = new Set();
export const requestLog = []; // for the "Under the hood" panel

function setSession(s) {
  session = s;
  for (const fn of listeners) fn(session);
}
export const getSession = () => session;
export function onSession(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function record(entry) {
  requestLog.unshift(entry);
  if (requestLog.length > 30) requestLog.pop();
}

async function rawFetch(method, path, { body, token } = {}) {
  const t0 = performance.now();
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  record({ method, path, status: res.status, ms: Math.round(performance.now() - t0), servedBy: res.headers.get('X-Served-By'), traceId: res.headers.get('X-Trace-Id'), readFrom: res.headers.get('X-Read-From') });
  return { res, json };
}

let refreshing = null;
export function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const { res, json } = await rawFetch('POST', '/api/auth/refresh');
    if (!res.ok) {
      setSession({ token: null, user: null, expiresAt: 0 });
      const err = new Error(json?.error?.message || 'Signed out');
      err.code = json?.error?.code;
      throw err;
    }
    setSession({ token: json.accessToken, user: json.user, expiresAt: Date.now() + json.expiresIn * 1000 });
    return json;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

// Refresh a minute before the access token expires.
setInterval(() => {
  if (session.token && session.expiresAt - Date.now() < 60_000) refresh().catch(() => {});
}, 20_000);

export async function api(method, path, body) {
  let { res, json } = await rawFetch(method, path, { body, token: session.token });
  if (res.status === 401 && session.token) {
    await refresh().catch(() => {});
    if (session.token) ({ res, json } = await rawFetch(method, path, { body, token: session.token }));
  }
  if (!res.ok) {
    const err = new Error(json?.error?.message || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = json?.error?.code;
    err.retryAfter = res.headers.get('Retry-After');
    throw err;
  }
  return json;
}

export async function login(email, password) {
  const { res, json } = await rawFetch('POST', '/api/auth/login', { body: { email, password } });
  if (!res.ok) {
    const err = new Error(json?.error?.message || 'Could not sign in');
    err.retryAfter = res.headers.get('Retry-After');
    throw err;
  }
  setSession({ token: json.accessToken, user: json.user, expiresAt: Date.now() + json.expiresIn * 1000 });
}

export async function signup(name, email, password) {
  const { res, json } = await rawFetch('POST', '/api/auth/signup', { body: { name, email, password } });
  if (!res.ok) throw new Error(json?.error?.message || 'Could not create the account');
  setSession({ token: json.accessToken, user: json.user, expiresAt: Date.now() + json.expiresIn * 1000 });
}

export async function logout() {
  await rawFetch('POST', '/api/auth/logout').catch(() => {});
  setSession({ token: null, user: null, expiresAt: 0 });
}

export async function wsTicket() {
  return api('POST', '/api/auth/ws-ticket');
}
