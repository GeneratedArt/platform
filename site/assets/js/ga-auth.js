/**
 * GeneratedArt browser-side auth helper. Stores a session token in
 * localStorage and exposes a tiny fetch wrapper that adds the bearer.
 *
 * GitHub OAuth flow (matches Worker route POST /auth/github/callback):
 *   1. User clicks "Sign in" → we redirect to github.com/login/oauth/authorize
 *      with our client id and a CSRF state stored in sessionStorage.
 *   2. GitHub redirects back to /auth/github/callback/ on this site with
 *      ?code=…&state=…
 *   3. We POST {code} to the API, receive {token, user_id}, persist them.
 */
(function () {
  const TOKEN_KEY = "ga.session.token";
  const USER_KEY = "ga.session.user";
  const STATE_KEY = "ga.oauth.state";
  const RETURN_KEY = "ga.oauth.return";

  const API = (window.GA_CONFIG && window.GA_CONFIG.api_base_url) || "/api";
  const CLIENT_ID =
    (window.GA_CONFIG && window.GA_CONFIG.github_client_id) || "";

  function getToken() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  }
  function setToken(t, user) {
    try {
      localStorage.setItem(TOKEN_KEY, t);
      if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    } catch {}
  }
  function clearToken() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    } catch {}
  }
  function getUser() {
    try {
      const raw = localStorage.getItem(USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  async function api(path, opts = {}) {
    const headers = new Headers(opts.headers || {});
    headers.set("Content-Type", "application/json");
    const tok = getToken();
    if (tok) headers.set("Authorization", `Bearer ${tok}`);
    const res = await fetch(`${API}${path}`, {
      ...opts,
      headers,
      credentials: "include",
    });
    let data = null;
    try {
      data = await res.json();
    } catch {}
    if (!res.ok) {
      const err = new Error((data && data.error) || `http_${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function startGitHubLogin(returnTo) {
    if (!CLIENT_ID) {
      alert(
        "GitHub OAuth client ID isn't configured yet. Set window.GA_CONFIG.github_client_id."
      );
      return;
    }
    const state = crypto.randomUUID();
    try {
      sessionStorage.setItem(STATE_KEY, state);
      sessionStorage.setItem(
        RETURN_KEY,
        returnTo || window.location.pathname + window.location.search
      );
    } catch {}
    const redirect = `${window.location.origin}/auth/github/callback/`;
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", redirect);
    url.searchParams.set("scope", "read:user");
    url.searchParams.set("state", state);
    window.location.href = url.toString();
  }

  async function completeGitHubLogin() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    if (!code) return null;
    const expected = sessionStorage.getItem(STATE_KEY);
    if (!state || state !== expected) {
      throw new Error("oauth_state_mismatch");
    }
    sessionStorage.removeItem(STATE_KEY);
    const data = await api("/auth/github/callback", {
      method: "POST",
      body: JSON.stringify({
        code,
        redirect_uri: `${window.location.origin}/auth/github/callback/`,
      }),
    });
    setToken(data.token, {
      user_id: data.user_id,
      github_login: data.github_login,
    });
    const ret = sessionStorage.getItem(RETURN_KEY) || "/studio/";
    sessionStorage.removeItem(RETURN_KEY);
    return ret;
  }

  async function fetchMe() {
    if (!getToken()) return null;
    try {
      const data = await api("/me");
      if (data && data.user) {
        setToken(getToken(), {
          user_id: data.user.id,
          github_login: data.user.github_login,
          role: data.user.role,
          display_name: data.user.display_name,
        });
      }
      return data && data.user ? data.user : null;
    } catch (err) {
      if (err.status === 401) clearToken();
      return null;
    }
  }

  // Wire any [data-ga-signin] button on the page.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-ga-signin]");
    if (!btn) return;
    e.preventDefault();
    startGitHubLogin();
  });

  window.gaAuth = {
    api,
    getToken,
    getUser,
    clearToken,
    startGitHubLogin,
    completeGitHubLogin,
    fetchMe,
  };
})();
