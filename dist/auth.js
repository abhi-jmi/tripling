/* Account sessions live in an HttpOnly server cookie. Passwords/tokens are never stored here. */
(() => {
  let user = null;
  let pending = null;
  const allowed = new Set([
    "view",
    "community",
    "save",
    "join",
    "create",
    "profile",
    "report",
    "notifications",
    "chat",
  ]);
  try {
    const action = JSON.parse(sessionStorage.getItem("tripling-return"));
    if (action && allowed.has(action.type)) pending = action;
  } catch {}
  async function api(path, options = {}) {
    let response;
    try {
      response = await fetch(`/api${path}`, {
        ...options,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", ...options.headers },
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch {
      throw new Error(
        "Cannot reach Tripling. Check your connection and try again.",
      );
    }
    const body = await response
      .json()
      .catch(() => ({ error: "The server returned an unexpected response." }));
    if (!response.ok) {
      const error = new Error(
        body.error || "The request could not be completed.",
      );
      error.status = response.status;
      if (response.status === 401) user = null;
      throw error;
    }
    return body;
  }
  window.TriplingAuth = {
    api,
    get session() {
      return user;
    },
    setUser(value) {
      user = value;
    },
    get pending() {
      return pending;
    },
    remember(action) {
      pending = action && allowed.has(action.type) ? action : null;
      try {
        if (pending)
          sessionStorage.setItem("tripling-return", JSON.stringify(pending));
        else sessionStorage.removeItem("tripling-return");
      } catch {}
    },
    consume() {
      const value = pending;
      this.remember(null);
      return value;
    },
    async login(email, password) {
      const result = await api("/auth/login", {
        method: "POST",
        body: { email, password },
      });
      user = result.user;
    },
    async signup(
      email,
      password,
      confirmPassword,
      age,
      legal,
      firstName,
      lastName,
    ) {
      const result = await api("/auth/signup", {
        method: "POST",
        body: {
          email,
          firstName,
          lastName,
          password,
          confirmPassword,
          age,
          acceptedLegal: true,
          termsVersion: legal.terms.version,
          privacyVersion: legal.privacy.version,
        },
      });
      user = result.user;
    },
    async logout() {
      await api("/auth/logout", { method: "POST", body: {} });
      user = null;
      this.remember(null);
    },
  };
})();
