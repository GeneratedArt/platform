/** @jsxImportSource preact */
/**
 * §12.1 — Primary artist creates a CollabInvite.
 *
 * Flow:
 *   1. Connect wallet (must match the artist's linked wallet)
 *   2. Fill form (collaborator address / role / bps)
 *   3. Sign EIP-712 typed data (eth_signTypedData_v4)
 *   4. POST {typed_data, signature, ...} to /projects/:slug/collabs
 *   5. List below shows pending + active collabs for this project
 */
import { useEffect, useState } from "preact/hooks";
import { keccak256, toBytes } from "viem";
import { apiFetch, CHAIN_ID } from "../lib/api";

declare global { interface Window { ethereum?: any } }

type CollabRow = {
  id: string;
  collaborator_address: string;
  role: string;
  bps: number;
  status: "pending" | "active" | "revoked" | "rejected";
  created_at: number;
};

const ROLES = ["co-artist", "engineer", "sound", "advisor", "curator-note"] as const;
type Role = typeof ROLES[number];

function shortAddr(a: string) { return a.slice(0, 6) + "…" + a.slice(-4); }

function randomNonce(): string {
  const b = new Uint8Array(32); crypto.getRandomValues(b);
  return "0x" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Mirrors workers/api/src/routes/collabs.ts → projectIdHash. Both sides MUST
 *  derive the same bytes32 so an EIP-712 signature signed in the wallet
 *  verifies on the worker (and, eventually, on-chain). */
function projectIdHash(slug: string): `0x${string}` {
  return keccak256(toBytes(`generatedart:project:${slug}`));
}

export default function CollabInviteIsland({ slug }: { slug: string }) {
  const [collabs, setCollabs] = useState<CollabRow[]>([]);
  const [account, setAccount] = useState<string | null>(null);
  const [collaborator, setCollaborator] = useState("");
  const [role, setRole] = useState<Role>("engineer");
  const [bps, setBps] = useState(1500);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function refresh() {
    try {
      const r = await apiFetch<{ collabs: CollabRow[] }>(`/projects/${slug}/collabs`, { auth: true });
      setCollabs(r.collabs ?? []);
    } catch (e: any) { setError(e.message); }
  }

  useEffect(() => {
    refresh();
    if (window.ethereum?.selectedAddress) setAccount(window.ethereum.selectedAddress);
  }, [slug]);

  async function connect() {
    setError(null);
    if (!window.ethereum) { setError("No wallet detected."); return; }
    try {
      const [a] = await window.ethereum.request({ method: "eth_requestAccounts" });
      setAccount(a);
    } catch (e: any) { setError(e?.message || "Connect failed"); }
  }

  async function submit(e: Event) {
    e.preventDefault();
    setError(null); setDone(null);
    if (!account) { setError("Connect your wallet first."); return; }
    if (!/^0x[0-9a-fA-F]{40}$/.test(collaborator.trim())) {
      setError("Collaborator address must be a 0x… hex address."); return;
    }
    if (collaborator.trim().toLowerCase() === account.toLowerCase()) {
      setError("You can't invite yourself."); return;
    }
    setBusy(true);
    try {
      const nonce = randomNonce();
      const projectId = projectIdHash(slug);
      const typed = {
        domain: { name: "GeneratedArt", version: "1", chainId: CHAIN_ID },
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
          ],
          CollabInvite: [
            { name: "projectId", type: "bytes32" },
            { name: "collaborator", type: "address" },
            { name: "role", type: "string" },
            { name: "bps", type: "uint16" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "CollabInvite" as const,
        message: { projectId, collaborator: collaborator.trim(), role, bps, nonce },
      };
      const signature: string = await window.ethereum.request({
        method: "eth_signTypedData_v4",
        params: [account, JSON.stringify(typed)],
      });
      // Worker-side schema doesn't include EIP712Domain in `types` — strip it.
      const { EIP712Domain: _drop, ...workerTypes } = typed.types as any;
      await apiFetch(`/projects/${slug}/collabs`, {
        method: "POST",
        auth: true,
        body: JSON.stringify({
          collaborator_address: collaborator.trim(),
          role, bps, nonce,
          typed_data: { ...typed, types: workerTypes },
          signature,
        }),
      });
      setDone("Invite signed and sent. The collaborator will see it on their dashboard.");
      setCollaborator("");
      await refresh();
    } catch (e: any) { setError(e?.message || "Failed to send invite"); }
    finally { setBusy(false); }
  }

  return (
    <div style="display:grid;gap:1.5rem">
      <form class="card" onSubmit={submit}>
        <h3 class="h-section" style="margin-top:0">Invite a collaborator</h3>
        {!account ? (
          <button class="btn" type="button" onClick={connect}>Connect wallet</button>
        ) : (
          <p class="mono subtle" style="font-size:.78rem">signer · {shortAddr(account)}</p>
        )}
        <label class="field">
          <span>Collaborator wallet (0x… or ENS — ENS resolution coming later)</span>
          <input class="input mono" type="text" value={collaborator}
                 onInput={(e: any) => setCollaborator(e.currentTarget.value)}
                 placeholder="0x0000000000000000000000000000000000000000" />
        </label>
        <label class="field">
          <span>Role</span>
          <select class="input" value={role} onChange={(e: any) => setRole(e.currentTarget.value)}>
            {ROLES.map((r) => <option value={r}>{r}</option>)}
          </select>
        </label>
        <label class="field">
          <span>Revenue share (basis points, of your portion — {(bps / 100).toFixed(2)}%)</span>
          <input class="input" type="number" min={0} max={10000} step={50} value={bps}
                 onInput={(e: any) => setBps(parseInt(e.currentTarget.value || "0", 10))} />
        </label>
        {error && <p class="error">{error}</p>}
        {done && <p class="notice">{done}</p>}
        <button class="btn" type="submit" disabled={busy || !account}>
          {busy ? "Signing…" : "Sign EIP-712 invite"}
        </button>
      </form>

      <section>
        <h3 class="eyebrow">Collaborators · {collabs.length}</h3>
        {collabs.length === 0 ? (
          <p class="muted">No invites yet.</p>
        ) : (
          <table class="table">
            <thead><tr><th>Collaborator</th><th>Role</th><th>Share</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {collabs.map((c) => (
                <tr key={c.id}>
                  <td class="mono" style="font-size:.78rem">{shortAddr(c.collaborator_address)}</td>
                  <td>{c.role}</td>
                  <td>{(c.bps / 100).toFixed(2)}%</td>
                  <td><span class={`pill pill--${c.status === "active" ? "live" : c.status === "pending" ? "review" : "sold-out"}`}>{c.status}</span></td>
                  <td>
                    {c.status === "pending" && (
                      <button class="btn btn--ghost btn--small" type="button"
                              onClick={async () => {
                                if (!confirm("Revoke this invite?")) return;
                                await apiFetch(`/collabs/${c.id}/revoke`, { method: "POST", auth: true, body: "{}" }).catch((e) => setError(e.message));
                                refresh();
                              }}>Revoke</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
