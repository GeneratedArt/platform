/** @jsxImportSource preact */
import { useEffect, useState } from "preact/hooks";
import { loadMe, clearSession, startGithubLogin, type Me } from "../lib/session";

export default function SignInIsland() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  useEffect(() => { loadMe().then(setMe).catch(() => setMe(null)); }, []);

  if (me === undefined) {
    return <span class="muted" style="font-size:.85rem">…</span>;
  }
  if (me === null) {
    return (
      <button class="app-nav__cta" type="button" onClick={() => startGithubLogin(location.pathname)}>
        Sign in
      </button>
    );
  }
  const label = me.display_name || me.github_login || (me.wallet_address ? me.wallet_address.slice(0, 6) + "…" + me.wallet_address.slice(-4) : "Account");
  return (
    <div class="row" style="gap:.6rem">
      <span class="pill" title={me.role}>{me.role}</span>
      <span style="font-size:.85rem">{label}</span>
      <button class="btn btn--ghost btn--small" type="button" onClick={() => { clearSession(); location.reload(); }}>
        Sign out
      </button>
    </div>
  );
}
