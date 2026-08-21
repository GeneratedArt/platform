/**
 * /wallet/ — token balance, packs, on-chain purchase, ledger history.
 *
 * No payment processor: buying a pack sends ETH directly to the
 * platform's treasury address, then posts the tx hash to
 * POST /v1/tokens/purchase/confirm, which verifies the receipt on-chain
 * before crediting the account (see tokens/handlers.ts). Mirrors the
 * wallet-connect + send-tx + wait-receipt shape already used by
 * client/mint.ts.
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  getAddress,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { installClientErrorReporter } from "./lib/clientErrors";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
    GAWallet?: typeof GAWallet;
  }
}

interface WalletConfig {
  apiBase: string;
  rootEl: HTMLElement;
  onUnauthenticated?: () => void;
}

interface AccountResp {
  balance: number;
  lifetime_purchased: number;
  lifetime_spent: number;
  lifetime_earned: number;
}

interface Pack {
  id: number;
  slug: string;
  title: string;
  tokens: number;
  price_wei: string;
}

interface PacksResp {
  packs: Pack[];
  purchase_configured: boolean;
  chain_id: number | null;
  treasury_address: string | null;
}

interface LedgerEntry {
  id: number;
  delta: number;
  kind: string;
  balance_after: number;
  ref_kind: string | null;
  ref_id: number | null;
  memo: string | null;
  created_at: number;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function fmtTokens(n: number): string {
  return n.toLocaleString("en-US");
}

// price_wei is a decimal string too large for Number — format to a
// human ETH amount without pulling in a bignum-decimal library.
function weiToEth(weiStr: string): string {
  const wei = BigInt(weiStr);
  const whole = wei / 1_000_000_000_000_000_000n;
  const frac = wei % 1_000_000_000_000_000_000n;
  const fracStr = frac.toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init });
  if (!res.ok) {
    let detail = "";
    try { detail = JSON.stringify(await res.json()); } catch {}
    throw new Error(`${res.status}: ${detail || res.statusText}`);
  }
  return (await res.json()) as T;
}

const KIND_LABELS: Record<string, string> = {
  grant: "Grant",
  purchase: "Purchase",
  debit: "Spend",
  refund: "Refund",
  earn: "Earned",
  adjust: "Adjustment",
};

function renderLedgerRow(e: LedgerEntry): string {
  const sign = e.delta > 0 ? "+" : "";
  const cls = e.delta > 0 ? "ga-ledger-credit" : "ga-ledger-debit";
  const when = new Date(e.created_at * 1000).toLocaleString();
  return `
    <tr>
      <td class="ga-ledger-when">${escapeHtml(when)}</td>
      <td>${escapeHtml(KIND_LABELS[e.kind] || e.kind)}</td>
      <td class="small text-muted">${escapeHtml(e.memo || "—")}</td>
      <td class="${cls} text-end">${sign}${fmtTokens(e.delta)}</td>
      <td class="text-end ga-ledger-balance">${fmtTokens(e.balance_after)}</td>
    </tr>`;
}

function renderPackCard(p: Pack, purchaseConfigured: boolean): string {
  return `
    <article class="ga-pack-card" data-pack-id="${p.id}">
      <h3 class="h5 mb-1">${escapeHtml(p.title)}</h3>
      <p class="ga-pack-tokens">${fmtTokens(p.tokens)} tokens</p>
      <p class="ga-pack-price">${weiToEth(p.price_wei)} ETH</p>
      <button
        class="btn btn-outline-dark rounded-0 ga-buy-btn"
        data-pack-id="${p.id}"
        ${purchaseConfigured ? "" : "disabled"}
      >Buy</button>
    </article>`;
}

class WalletPage {
  private cfg!: WalletConfig;
  private treasury: Hex | null = null;
  private chainId: number | null = null;
  private connectedAddress: Hex | null = null;

  async mount(cfg: WalletConfig): Promise<void> {
    this.cfg = cfg;
    installClientErrorReporter({ apiBase: cfg.apiBase, page: "wallet" });

    let me: unknown = null;
    try {
      me = await fetchJson(`${cfg.apiBase}/v1/me`);
    } catch {
      me = null;
    }
    if (!me) {
      cfg.onUnauthenticated?.();
      return;
    }

    await this.loadAccount();
    await this.loadPacks();
    await this.loadLedger();
    this.attachEvents();
  }

  private async loadAccount(): Promise<void> {
    const balEl = this.cfg.rootEl.querySelector<HTMLElement>("#ga-wallet-balance");
    const purchasedEl = this.cfg.rootEl.querySelector<HTMLElement>("#ga-wallet-purchased");
    const spentEl = this.cfg.rootEl.querySelector<HTMLElement>("#ga-wallet-spent");
    const earnedEl = this.cfg.rootEl.querySelector<HTMLElement>("#ga-wallet-earned");
    if (!balEl) return;
    try {
      const acct = await fetchJson<AccountResp>(`${this.cfg.apiBase}/v1/tokens/account`);
      balEl.textContent = fmtTokens(acct.balance);
      if (purchasedEl) purchasedEl.textContent = fmtTokens(acct.lifetime_purchased);
      if (spentEl) spentEl.textContent = fmtTokens(acct.lifetime_spent);
      if (earnedEl) earnedEl.textContent = fmtTokens(acct.lifetime_earned);
    } catch {
      balEl.textContent = "—";
    }
  }

  private async loadPacks(): Promise<void> {
    const el = this.cfg.rootEl.querySelector<HTMLElement>("#ga-wallet-packs");
    if (!el) return;
    try {
      const data = await fetchJson<PacksResp>(`${this.cfg.apiBase}/v1/tokens/packs`);
      // Validated + checksummed here rather than trusted verbatim from
      // the API — getAddress throws on a malformed address, which we'd
      // rather surface as "purchasing unavailable" than as a wallet
      // error deep inside the buy flow.
      try {
        this.treasury = data.treasury_address ? getAddress(data.treasury_address) : null;
      } catch {
        this.treasury = null;
      }
      this.chainId = data.chain_id;
      if (!data.purchase_configured) {
        el.insertAdjacentHTML(
          "beforebegin",
          `<p class="small text-muted mb-4">Purchasing isn't configured yet — packs are shown, but Buy is disabled.</p>`,
        );
      }
      el.innerHTML = data.packs.map((p) => renderPackCard(p, data.purchase_configured)).join("");
    } catch (err) {
      el.innerHTML = `<div class="alert alert-danger">Failed to load packs: ${escapeHtml(String(err))}</div>`;
    }
  }

  private async loadLedger(before?: number): Promise<void> {
    const bodyEl = this.cfg.rootEl.querySelector<HTMLElement>("#ga-ledger-body");
    const moreBtn = this.cfg.rootEl.querySelector<HTMLButtonElement>("#ga-ledger-more");
    if (!bodyEl) return;
    try {
      const qs = before ? `?before=${before}` : "";
      const data = await fetchJson<{ entries: LedgerEntry[]; next_before: number | null }>(
        `${this.cfg.apiBase}/v1/tokens/ledger${qs}`,
      );
      const rows = data.entries.map(renderLedgerRow).join("");
      bodyEl.insertAdjacentHTML("beforeend", rows);
      if (!before && !data.entries.length) {
        bodyEl.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-4">No activity yet.</td></tr>`;
      }
      if (moreBtn) {
        if (data.next_before) {
          moreBtn.classList.remove("d-none");
          moreBtn.dataset.before = String(data.next_before);
        } else {
          moreBtn.classList.add("d-none");
        }
      }
    } catch (err) {
      bodyEl.innerHTML = `<tr><td colspan="5" class="text-danger small">Failed to load: ${escapeHtml(String(err))}</td></tr>`;
    }
  }

  private feedback(msg: string): void {
    const el = this.cfg.rootEl.querySelector<HTMLElement>("#ga-wallet-feedback");
    if (el) el.textContent = msg;
  }

  private async ensureConnected(): Promise<boolean> {
    if (this.connectedAddress) return true;
    if (!window.ethereum) {
      this.feedback("No injected wallet found. Install MetaMask or a Base-compatible wallet.");
      return false;
    }
    try {
      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as Hex[];
      if (!accounts?.length) return false;
      this.connectedAddress = getAddress(accounts[0]);
      return true;
    } catch (e) {
      this.feedback(`Wallet connect failed: ${(e as Error).message}`);
      return false;
    }
  }

  private async buy(packId: number, button: HTMLButtonElement): Promise<void> {
    const treasury = this.treasury;
    if (!treasury || this.chainId === null) {
      this.feedback("Purchasing isn't configured yet.");
      return;
    }
    if (!(await this.ensureConnected())) return;
    // A local const (not `this.connectedAddress` directly) so it
    // narrows from `Hex | null` for the eth_sendTransaction call below —
    // TS can't carry a field narrowing across the ensureConnected() call.
    const from = this.connectedAddress;
    if (!from) return;

    const original = button.textContent;
    button.disabled = true;
    try {
      // Re-fetch the pack's current price at buy time rather than
      // trusting a value cached in the DOM from page load.
      button.textContent = "Preparing…";
      const data = await fetchJson<PacksResp>(`${this.cfg.apiBase}/v1/tokens/packs`);
      const pack = data.packs.find((p) => p.id === packId);
      if (!pack) throw new Error("pack no longer available");

      await this.ensureChain(this.chainId!);

      button.textContent = "Awaiting wallet…";
      const valueHex = ("0x" + BigInt(pack.price_wei).toString(16)) as Hex;
      const txHash = (await window.ethereum!.request({
        method: "eth_sendTransaction",
        params: [{ from, to: treasury, value: valueHex }],
      })) as Hex;
      this.feedback(`Transaction sent: ${txHash.slice(0, 10)}…`);

      button.textContent = "Confirming on-chain…";
      const publicClient = createPublicClient({ transport: http() });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") {
        this.feedback("Transaction reverted on-chain.");
        return;
      }

      button.textContent = "Crediting account…";
      await fetchJson(`${this.cfg.apiBase}/v1/tokens/purchase/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pack_id: pack.id, tx_hash: txHash }),
      });
      this.feedback(`Purchased ${fmtTokens(pack.tokens)} tokens.`);
      await this.loadAccount();
    } catch (e) {
      this.feedback(`Purchase failed: ${(e as Error).message}`);
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  private async ensureChain(chainId: number): Promise<void> {
    if (!window.ethereum) return;
    const current = (await window.ethereum.request({ method: "eth_chainId" })) as Hex;
    const hex = ("0x" + chainId.toString(16)) as Hex;
    if (current.toLowerCase() === hex.toLowerCase()) return;
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: hex }],
      });
    } catch {
      // Wallet may not have the chain added yet; surfaced by the
      // subsequent send failing with a clearer wallet-side error.
    }
  }

  private attachEvents(): void {
    this.cfg.rootEl.addEventListener("click", (ev) => {
      const target = ev.target as HTMLElement;
      const buyBtn = target.closest<HTMLButtonElement>(".ga-buy-btn");
      if (buyBtn) {
        const id = parseInt(buyBtn.dataset.packId || "", 10);
        if (id) void this.buy(id, buyBtn);
        return;
      }
      const moreBtn = target.closest<HTMLButtonElement>("#ga-ledger-more");
      if (moreBtn) {
        const before = parseInt(moreBtn.dataset.before || "", 10);
        if (before) void this.loadLedger(before);
      }
    });
  }
}

const GAWallet = {
  async mount(cfg: WalletConfig) {
    await new WalletPage().mount(cfg);
  },
};

window.GAWallet = GAWallet;
export default GAWallet;
