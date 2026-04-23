/** @jsxImportSource preact */
/**
 * §12.2 — Collaborator views the signed invite, counter-signs, posts /accept.
 */
import { useEffect, useState } from "preact/hooks";
import { apiFetch, SITE_BASE } from "../lib/api";

declare global { interface Window { ethereum?: any } }

type Collab = {
  id: string;
  project_slug: string;
  project_title: string;
  inviter_address: string;
  collaborator_address: string;
  role: string;
  bps: number;
  status: "pending" | "active" | "revoked" | "rejected";
  typed_data: any;
  invite_signature: string;
  accept_signature: string | null;
  created_at: number;
  responded_at: number | null;
};

function shortAddr(a: string) { return a.slice(0, 6) + "…" + a.slice(-4); }

export default function CollabAcceptIsland({ id }: { id: string }) {
  const [collab, setCollab] = useState<Collab | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState<"accept" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ collab: Collab }>(`/collabs/${id}`, { auth: true })
      .then((r) => setCollab(r.collab))
      .catch((e) => setError(e.message));
    if (window.ethereum?.selectedAddress) setAccount(window.ethereum.selectedAddress);
  }, [id]);

  async function connect() {
    setError(null);
    if (!window.ethereum) { setError("No wallet detected."); return; }
    try {
      const [a] = await window.ethereum.request({ method: "eth_requestAccounts" });
      setAccount(a);
    } catch (e: any) { setError(e?.message || "Connect failed"); }
  }

  async function accept() {
    if (!collab || !account) return;
    setError(null); setDone(null); setBusy("accept");
    try {
      // Re-attach EIP712Domain for wallet UI (worker stores types without it).
      const typedForWallet = {
        ...collab.typed_data,
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
          ],
          ...collab.typed_data.types,
        },
      };
      const signature: string = await window.ethereum.request({
        method: "eth_signTypedData_v4",
        params: [account, JSON.stringify(typedForWallet)],
      });
      await apiFetch(`/collabs/${id}/accept`, {
        method: "POST", auth: true,
        body: JSON.stringify({ signature }),
      });
      setDone("Accepted. The collaboration is now active.");
      const r = await apiFetch<{ collab: Collab }>(`/collabs/${id}`, { auth: true });
      setCollab(r.collab);
    } catch (e: any) { setError(e?.message || "Accept failed"); }
    finally { setBusy(null); }
  }

  async function reject() {
    if (!collab) return;
    if (!confirm("Reject this collaboration request?")) return;
    setBusy("reject"); setError(null);
    try {
      await apiFetch(`/collabs/${id}/revoke`, { method: "POST", auth: true, body: JSON.stringify({ reason: "rejected by collaborator" }) });
      setDone("Rejected.");
      const r = await apiFetch<{ collab: Collab }>(`/collabs/${id}`, { auth: true });
      setCollab(r.collab);
    } catch (e: any) { setError(e?.message || "Reject failed"); }
    finally { setBusy(null); }
  }

  if (error && !collab) return <p class="error">{error}</p>;
  if (!collab) return <p class="muted">Loading invite…</p>;

  const isMine = account && account.toLowerCase() === collab.collaborator_address;
  const isPending = collab.status === "pending";

  return (
    <div class="card" style="display:grid;gap:1rem;max-width:640px">
      <div>
        <p class="eyebrow">Collaboration request</p>
        <h2 class="h-section" style="margin:.25rem 0">{collab.project_title}</h2>
        <a class="mono subtle" style="font-size:.85rem" href={`${SITE_BASE}/projects/${collab.project_slug}/`} target="_blank" rel="noopener">
          /projects/{collab.project_slug} →
        </a>
      </div>

      <dl class="kv">
        <dt>From</dt><dd class="mono">{shortAddr(collab.inviter_address)}</dd>
        <dt>To</dt><dd class="mono">{shortAddr(collab.collaborator_address)}</dd>
        <dt>Role</dt><dd>{collab.role}</dd>
        <dt>Revenue share</dt><dd>{(collab.bps / 100).toFixed(2)}% of the artist's portion</dd>
        <dt>Status</dt><dd><span class={`pill pill--${collab.status === "active" ? "live" : isPending ? "review" : "sold-out"}`}>{collab.status}</span></dd>
      </dl>

      <details>
        <summary class="muted" style="cursor:pointer">Show signed EIP-712 payload</summary>
        <pre class="mono" style="font-size:.72rem;white-space:pre-wrap;word-break:break-all">{JSON.stringify(collab.typed_data, null, 2)}</pre>
        <p class="mono subtle" style="font-size:.7rem">inviter signature · {collab.invite_signature.slice(0, 18)}…</p>
      </details>

      {error && <p class="error">{error}</p>}
      {done && <p class="notice">{done}</p>}

      {isPending && !account && (
        <button class="btn" type="button" onClick={connect}>Connect wallet to respond</button>
      )}
      {isPending && account && !isMine && (
        <p class="error">Connected wallet ({shortAddr(account)}) doesn't match this invite. Switch to {shortAddr(collab.collaborator_address)}.</p>
      )}
      {isPending && isMine && (
        <div class="row" style="gap:.5rem">
          <button class="btn" type="button" disabled={!!busy} onClick={accept}>
            {busy === "accept" ? "Signing…" : "Accept & counter-sign"}
          </button>
          <button class="btn btn--ghost" type="button" disabled={!!busy} onClick={reject}>
            {busy === "reject" ? "…" : "Reject"}
          </button>
        </div>
      )}
    </div>
  );
}
