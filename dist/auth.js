/* UI-only preview sessions. This is not email verification or a security boundary. */
(() => {
  'use strict';
  const SESSION_KEY = 'tripling-preview-session-v1';
  const INTENT_KEY = 'tripling-preview-intent-v1';
  const SESSION_MS = 8 * 60 * 60 * 1000;
  const allowedActions = new Set(['view', 'save', 'join', 'create', 'profile', 'report']);
  const validEmail = value => {
    if (typeof value !== 'string' || value.length > 254) return false;
    const parts = value.split('@');
    if (parts.length !== 2 || !parts[0] || parts[0].length > 64 || parts[0].startsWith('.') || parts[0].endsWith('.') || parts[0].includes('..')) return false;
    if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(parts[0])) return false;
    const labels = parts[1].split('.');
    return labels.length >= 2 && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) && /^[a-z]{2,63}$/i.test(labels.at(-1));
  };
  let current = null;
  let intent = null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY));
    if (saved && validEmail(saved.email) && /^[a-f0-9-]{36}$/.test(saved.id) && Number.isFinite(saved.expiresAt) && saved.expiresAt > Date.now()) current = saved;
    else sessionStorage.removeItem(SESSION_KEY);
    const pending = JSON.parse(sessionStorage.getItem(INTENT_KEY));
    if (pending && allowedActions.has(pending.type)) intent = pending;
  } catch { /* In-memory sessions still work when browser storage is disabled. */ }
  function write(key, value) {
    try { if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key); } catch {}
  }
  window.TriplingAuth = {
    get session() {
      if (current && current.expiresAt <= Date.now()) { current = null; write(SESSION_KEY, null); }
      return current;
    },
    get storageKey() { return this.session ? `tripling-preview-data-${current.id}` : null; },
    validEmail,
    start(email) {
      email = String(email).trim().toLowerCase();
      if (!validEmail(email)) throw new Error('Enter a valid email address, such as you@example.com.');
      current = { email, id: crypto.randomUUID(), expiresAt: Date.now() + SESSION_MS };
      write(SESSION_KEY, current);
      return current;
    },
    remember(action) {
      intent = action && allowedActions.has(action.type) ? action : null;
      write(INTENT_KEY, intent);
    },
    get pending() { return intent; },
    consume() { const pending = intent; intent = null; write(INTENT_KEY, null); return pending; },
    end() {
      // Remove this preview's local records on sign-out; never expose them to the next session.
      const key = this.storageKey;
      if (key) { try { localStorage.removeItem(key); } catch {} }
      current = null; intent = null;
      write(SESSION_KEY, null); write(INTENT_KEY, null);
    }
  };
})();
