/** @jsxImportSource preact */
import { useEffect, useMemo, useState } from "preact/hooks";
import { apiFetch, RENDERER_BASE } from "../lib/api";

type MintParams = {
  chain_id: number;
  contract: string;
  price_wei: string;
  remaining: number;
};
type Project = {
  slug: string;
  title: string;
  bundle_cid?: string;
  edition_size: number;
  minted?: number;
  status: string;
};

declare global { interface Window { ethereum?: any } }

const BASE_CHAIN = { id: 8453, hex: "0x2105", name: "Base" };
const BASE_SEPOLIA = { id: 84532, hex: "0x14a34", name: "Base Sepolia" };

function shortAddr(a: string) { return a.slice(0, 6) + "…" + a.slice(-4); }
function fromWei(v: string) {
  try { const n = BigInt(v); return (Number(n) / 1e18).toString(); } catch { return v; }
}
function previewHash() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function MintIsland({ slug }: { slug: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [params, setParams] = useState<MintParams | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [hash, setHash] = useState<string>(previewHash());
  const [tx, setTx] = useState<string | null>(null);
  const [busy, setBusy] = useState<"connect" | "switch" | "mint" | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch<{ project: Project }>(`/projects/${slug}`).then((r) => r.project).catch(() => null),
      apiFetch<MintParams>(`/projects/${slug}/mint-params`).catch(() => null),
    ]).then(([p, mp]) => {
      if (cancelled) return;
      setProject(p);
      setParams(mp);
    });
    if (window.ethereum?.selectedAddress) setAccount(window.ethereum.selectedAddress);
    return () => { cancelled = true; };
  }, [slug]);

  const targetChain = useMemo(() => {
    if (!params) return BASE_CHAIN;
    return params.chain_id === BASE_SEPOLIA.id ? BASE_SEPOLIA : BASE_CHAIN;
  }, [params]);

  async function connect() {
    setError(null);
    if (!window.ethereum) { setError("No wallet detected. Install MetaMask or another EIP-1193 wallet."); return; }
    setBusy("connect");
    try {
      const [a] = await window.ethereum.request({ method: "eth_requestAccounts" });
      setAccount(a);
    } catch (e: any) { setError(e?.message || "Connect failed"); }
    finally { setBusy(null); }
  }

  async function ensureChain(): Promise<boolean> {
    if (!window.ethereum) return false;
    try {
      const cur = await window.ethereum.request({ method: "eth_chainId" });
      if (cur === targetChain.hex) return true;
      setBusy("switch");
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: targetChain.hex }],
      });
      return true;
    } catch (e: any) {
      setError(`Please switch to ${targetChain.name} (chain ${targetChain.id}).`);
      return false;
    } finally { setBusy(null); }
  }

  async function mint() {
    if (!params || !account) return;
    setError(null);
    if (!(await ensureChain())) return;
    setBusy("mint");
    try {
      // mint(address to) — selector 0x6a627842; pad recipient to 32 bytes.
      const selector = "0x6a627842";
      const to = account.toLowerCase().replace(/^0x/, "").padStart(64, "0");
      const data = selector + to;
      const txHash: string = await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [{
          from: account,
          to: params.contract,
          value: "0x" + BigInt(params.price_wei).toString(16),
          data,
        }],
      });
      setTx(txHash);
    } catch (e: any) {
      setError(e?.message || "Mint failed");
    } finally { setBusy(null); }
  }

  const explorer = targetChain.id === BASE_SEPOLIA.id
    ? `https://sepolia.basescan.org/tx/${tx}`
    : `https://basescan.org/tx/${tx}`;

  const minted = project?.minted ?? 0;
  const size = project?.edition_size ?? 1;
  const pct = Math.min(100, Math.round((minted / size) * 100));
  const soldOut = !!params && params.remaining <= 0;

  return (
    <div style="display:grid;gap:1.5rem;grid-template-columns:1fr;align-items:start">
      <div class="card" style="padding:0">
        <div class="card__media" style="border:0;border-radius:8px 8px 0 0">
          {project?.bundle_cid ? (
            <iframe
              key={hash}
              src={`${RENDERER_BASE}/render?cid=${project.bundle_cid}&hash=${hash}&res=1024x1024`}
              sandbox="allow-scripts allow-pointer-lock"
              title={`${project.title} preview`}
              loading="lazy"
            />
          ) : (
            <div style="display:grid;place-items:center;color:var(--fg-subtle);height:100%">No bundle pinned yet</div>
          )}
        </div>
        <div class="row row--between" style="padding:.85rem 1.1rem;border-top:1px solid var(--rule)">
          <span class="mono subtle" style="font-size:.78rem">preview hash · {hash.slice(0, 10)}…</span>
          <button class="btn btn--ghost btn--small" type="button" onClick={() => setHash(previewHash())}>Roll</button>
        </div>
      </div>

      <div class="card">
        <div class="row row--between">
          <div>
            <div class="eyebrow">Mint</div>
            <h2 class="h-section" style="margin:.25rem 0">{params ? `${fromWei(params.price_wei)} ETH` : "—"}</h2>
            <span class="muted" style="font-size:.85rem">on {targetChain.name}</span>
          </div>
          <span class={`pill ${soldOut ? "pill--sold-out" : "pill--live"}`}>
            {soldOut ? "Sold out" : <><span class="dot" />Live</>}
          </span>
        </div>

        <div>
          <div class="row row--between mono subtle" style="font-size:.75rem">
            <span>{minted} / {size} minted</span>
            <span>{pct}%</span>
          </div>
          <span class="progress"><span class="progress__bar" style={{ width: `${pct}%` }} /></span>
        </div>

        {error && <p class="error">{error}</p>}

        {!account && (
          <button class="btn" type="button" disabled={!!busy} onClick={connect}>
            {busy === "connect" ? "Connecting…" : "Connect wallet"}
          </button>
        )}
        {account && !tx && (
          <div class="row" style="gap:.5rem">
            <button class="btn" type="button" disabled={!params || soldOut || !!busy} onClick={mint}>
              {busy === "switch" ? "Switching network…" : busy === "mint" ? "Minting…" : "Mint"}
            </button>
            <span class="mono subtle" style="font-size:.75rem">from {shortAddr(account)}</span>
          </div>
        )}
        {tx && (
          <div>
            <p class="notice">Transaction submitted.</p>
            <a class="mono" style="font-size:.85rem;border-bottom-color:var(--rule)" href={explorer} target="_blank" rel="noopener">{tx.slice(0, 14)}…</a>
          </div>
        )}
      </div>
    </div>
  );
}
