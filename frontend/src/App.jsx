import { useState, useEffect, useCallback } from 'react';

const API = import.meta.env.VITE_API_URL;

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [email, setEmail] = useState(localStorage.getItem('email') || '');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState('login');
  const [url, setUrl] = useState('');
  const [alias, setAlias] = useState('');
  const [links, setLinks] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');

  const logout = useCallback(() => {
    localStorage.removeItem('token');
    setToken(null);
    setLinks([]);
  }, []);

  const api = useCallback(
    async (path, options = {}) => {
      const res = await fetch(`${API}${path}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (res.status === 401 && token) logout(); // token expired
      const data = res.status === 204 ? null : await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
      return data;
    },
    [token, logout]
  );

  const loadLinks = useCallback(async () => {
    try {
      setLinks(await api('/api/links'));
    } catch (e) {
      setError(e.message);
    }
  }, [api]);

  useEffect(() => {
    if (token) loadLinks();
  }, [token, loadLinks]);

  async function submitAuth(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const data = await api(`/api/auth/${mode}`, {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      localStorage.setItem('token', data.token);
      localStorage.setItem('email', email);
      setToken(data.token);
      setPassword('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function shorten(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const body = { url };
      if (alias.trim()) body.customAlias = alias.trim();
      await api('/api/links', { method: 'POST', body: JSON.stringify(body) });
      setUrl('');
      setAlias('');
      await loadLinks();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(code) {
    setError('');
    try {
      await api(`/api/links/${code}`, { method: 'DELETE' });
      await loadLinks();
    } catch (err) {
      setError(err.message);
    }
  }

  async function copy(text) {
    await navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(''), 1500);
  }

  if (!token) {
    return (
      <main className="card">
        <h1>URL Shortener</h1>
        <form onSubmit={submitAuth}>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            type="password"
            placeholder="Password (8+ characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
          <button disabled={busy}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}
          </button>
        </form>
        {error && <p className="error">{error}</p>}
        <p className="muted">
          {mode === 'login' ? 'New here? ' : 'Already registered? '}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setMode(mode === 'login' ? 'register' : 'login');
              setError('');
            }}
          >
            {mode === 'login' ? 'Create an account' : 'Log in'}
          </a>
        </p>
        <p className="muted">The first request may take up to a minute while the free server wakes up.</p>
      </main>
    );
  }

  return (
    <main className="card wide">
      <header>
        <h1>URL Shortener</h1>
        <button className="ghost" onClick={logout}>Log out</button>
      </header>

      <form onSubmit={shorten} className="row">
        <input
          type="url"
          placeholder="https://your-long-url.com/..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
        />
        <input
          placeholder="Custom alias (optional)"
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          className="alias"
        />
        <button disabled={busy}>{busy ? '…' : 'Shorten'}</button>
      </form>
      {error && <p className="error">{error}</p>}

      <table>
        <thead>
          <tr><th>Short link</th><th>Original</th><th>Clicks</th><th></th></tr>
        </thead>
        <tbody>
          {links.length === 0 && (
            <tr><td colSpan="4" className="muted">No links yet.</td></tr>
          )}
          {links.map((l) => (
            <tr key={l.code}>
              <td><a href={l.shortUrl} target="_blank" rel="noreferrer">{l.shortUrl}</a></td>
              <td className="long">{l.long_url}</td>
              <td>{l.click_count}</td>
              <td className="actions">
                <button className="ghost" onClick={() => copy(l.shortUrl)}>
                  {copied === l.shortUrl ? 'Copied!' : 'Copy'}
                </button>
                <button className="ghost danger" onClick={() => remove(l.code)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}