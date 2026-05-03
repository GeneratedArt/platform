/**
 * /t/?p=N&id=T — single-token detail page.
 *
 * Fetches `/v1/projects/:p/mints/:id`, renders the trait map with
 * each value linked to /explore?trait=name:value, and points an
 * iframe at the IPFS frozen bundle with `?seed=…` so the same art
 * the collector minted is reproducible from the URL alone.
 */
interface TokenResp {
  project: {
    id: number;
    slug: string;
    title: string;
    owner_id: number;
    frozen_cid: string | null;
    contract_address: string | null;
    chain_id: number | null;
  };
  mint: {
    id: number;
    project_id: number | null;
    contract_address: string;
    chain_id: number;
    token_id: string;
    owner_address: string;
    tx_hash: string;
    minted_at: number;
    seed: string | null;
    traits: Record<string, string> | null;
  };
  rarity_score: number | null;
}

interface TokenDetailConfig {
  apiBase: string;
  rootEl: HTMLElement;
}

declare global {
  interface Window {
    GATokenDetail?: typeof GATokenDetail;
  }
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

function basescanBase(chainId: number | null): string {
  if (chainId === 8453) return "https://basescan.org";
  return "https://sepolia.basescan.org";
}

// The frozen bundle is keyed off the bytes32 seed emitted by the
// `Minted` event — that's what the studio preview iframe and the
// mint client both use, so it's the only URL that reproduces the
// exact art the collector minted. We persisted the seed in the mint
// row at confirm-mint time. Older rows (pre-0015 migration) carry
// null seed; we fall back to a deterministic seed derived from the
// token id so they still render *something* instead of breaking.
function bundleUrl(cid: string, tokenId: string, seed: string | null): string {
  const effective = seed ?? "0x" + BigInt(tokenId).toString(16).padStart(64, "0");
  return `https://${cid}.ipfs.dweb.link/?seed=${effective}`;
}

function renderError(cfg: TokenDetailConfig, msg: string) {
  cfg.rootEl.innerHTML = `
    <div class="text-center py-10">
      <h1 class="h3 mb-3">Token not found</h1>
      <p class="text-muted small mb-4">${escapeHtml(msg)}</p>
      <a href="/" class="btn btn-outline-primary rounded-0">Back home</a>
    </div>`;
}

async function render(cfg: TokenDetailConfig, data: TokenResp) {
  const tmpl = document.getElementById(
    "ga-token-tmpl",
  ) as HTMLTemplateElement | null;
  if (!tmpl) return;
  const node = tmpl.content.cloneNode(true) as DocumentFragment;
  const root = node.querySelector(".ga-token-detail")!;

  const projectLink = root.querySelector(".ga-token-project") as HTMLAnchorElement;
  projectLink.href = `/p/?id=${data.project.id}`;
  projectLink.textContent = data.project.title;
  root.querySelector(".ga-token-id")!.textContent = data.mint.token_id;
  root.querySelector(".ga-token-owner")!.textContent =
    `${data.mint.owner_address.slice(0, 6)}…${data.mint.owner_address.slice(-4)}`;
  root.querySelector(".ga-token-title")!.textContent =
    `${data.project.title} #${data.mint.token_id}`;

  const art = root.querySelector(".ga-token-art") as HTMLIFrameElement;
  if (data.project.frozen_cid) {
    art.src = bundleUrl(data.project.frozen_cid, data.mint.token_id, data.mint.seed);
  } else {
    art.replaceWith(
      Object.assign(document.createElement("p"), {
        className: "text-muted small p-3",
        textContent: "No frozen bundle pinned yet — art is unavailable.",
      }),
    );
  }

  const traitsEl = root.querySelector(".ga-token-traits") as HTMLElement;
  const traits = data.mint.traits ?? {};
  const names = Object.keys(traits);
  if (names.length === 0) {
    traitsEl.innerHTML = `<li class="text-muted">No traits captured.</li>`;
  } else {
    traitsEl.innerHTML = names
      .map((n) => {
        const v = traits[n];
        const exploreHref = `/explore/?trait=${encodeURIComponent(n)}:${encodeURIComponent(v)}`;
        return `
          <li>
            <span class="name">${escapeHtml(n)}</span>
            <span><a class="value" href="${exploreHref}">${escapeHtml(v)}</a></span>
          </li>`;
      })
      .join("");
  }

  const rarityEl = root.querySelector(".ga-token-rarity") as HTMLElement;
  rarityEl.textContent =
    data.rarity_score !== null ? data.rarity_score.toFixed(2) : "—";

  const txLink = root.querySelector(".ga-token-tx") as HTMLAnchorElement;
  const explorerBase = basescanBase(data.mint.chain_id);
  txLink.href = `${explorerBase}/tx/${data.mint.tx_hash}`;
  txLink.textContent = `${data.mint.tx_hash.slice(0, 10)}…${data.mint.tx_hash.slice(-6)}`;

  const contractLink = root.querySelector(".ga-token-contract") as HTMLAnchorElement;
  contractLink.href = `${explorerBase}/address/${data.mint.contract_address}`;
  contractLink.textContent = `${data.mint.contract_address.slice(0, 6)}…${data.mint.contract_address.slice(-4)}`;

  const mintedEl = root.querySelector(".ga-token-minted-at") as HTMLElement;
  mintedEl.textContent = `Minted ${new Date(data.mint.minted_at * 1000).toLocaleDateString()}`;

  cfg.rootEl.innerHTML = "";
  cfg.rootEl.appendChild(node);
  document.title = `${data.project.title} #${data.mint.token_id} — GeneratedArt`;
}

const GATokenDetail = {
  async mount(cfg: TokenDetailConfig) {
    const params = new URLSearchParams(window.location.search);
    const projectId = parseInt(params.get("p") || "", 10);
    const tokenId = (params.get("id") || "").trim();
    if (!projectId || Number.isNaN(projectId) || !tokenId || !/^[0-9]+$/.test(tokenId)) {
      renderError(cfg, "Bad URL — token URLs look like /t/?p=123&id=42.");
      return;
    }
    const res = await fetch(
      `${cfg.apiBase}/v1/projects/${projectId}/mints/${encodeURIComponent(tokenId)}`,
      { credentials: "include" },
    );
    if (!res.ok) {
      renderError(
        cfg,
        res.status === 404
          ? `Token #${tokenId} for project #${projectId} doesn't exist.`
          : `Couldn't load token (${res.status}).`,
      );
      return;
    }
    const data = (await res.json()) as TokenResp;
    await render(cfg, data);
  },
};

window.GATokenDetail = GATokenDetail;
export default GATokenDetail;
