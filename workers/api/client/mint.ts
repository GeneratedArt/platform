import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseAbiItem,
  decodeEventLog,
  getAddress,
  type Address,
  type EIP1193Provider,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
    GAMint?: typeof GAMint;
  }
}

interface MintConfig {
  apiBase: string;
}

const DEFAULTS: MintConfig = { apiBase: "http://localhost:8787" };

const PROJECT_CREATED = parseAbiItem(
  "event ProjectCreated(address indexed project, address indexed artist, string name, string symbol, uint96 royaltyBps, uint256 maxSupply)",
);
const MINTED = parseAbiItem(
  "event Minted(uint256 indexed tokenId, address indexed to, bytes32 seed)",
);

interface ProjectShape {
  id: number;
  owner_id: number;
  title: string;
  description: string | null;
  status: string;
  contract_address: string | null;
  frozen_cid: string | null;
  deploy_tx_hash: string | null;
  chain_id: number | null;
}

interface OwnerShape {
  id: number;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
}

interface ChainInfo {
  id: number;
  rpcUrl: string;
}

interface PreparePayload {
  phase: "deploy" | "lock_cid" | "mint";
  chain: ChainInfo;
  to: Hex;
  data: Hex;
  value: Hex;
  meta: Record<string, unknown>;
}

function basescanBase(chainId: number): string {
  if (chainId === 8453) return "https://basescan.org";
  return "https://sepolia.basescan.org";
}

function chainLabel(chainId: number): string {
  if (chainId === 8453) return "Base";
  if (chainId === 84532) return "Base Sepolia";
  return `Chain ${chainId}`;
}

class MintController {
  private cfg: MintConfig;
  private projectId: number;
  private root: HTMLElement;
  private project: ProjectShape | null = null;
  private owner: OwnerShape | null = null;
  private viewer: { uid: number; handle: string } | null = null;
  private connectedAddress: Address | null = null;
  private wallet: WalletClient | null = null;
  private node: HTMLElement | null = null;
  private chainState: {
    cid_locked: boolean;
    total_minted: string | null;
    max_supply: string | null;
  } | null = null;

  constructor(cfg: MintConfig, root: HTMLElement, projectId: number) {
    this.cfg = cfg;
    this.root = root;
    this.projectId = projectId;
  }

  static async start(cfg: Partial<MintConfig> = {}): Promise<void> {
    const merged = { ...DEFAULTS, ...cfg };
    const root = document.getElementById("ga-mint-root");
    if (!root) return;
    const id = Number(new URLSearchParams(location.search).get("id") || "");
    if (!Number.isInteger(id) || id <= 0) {
      root.innerHTML = `<div class="alert alert-warning">Missing or invalid <code>?id=</code> parameter.</div>`;
      return;
    }
    const ctrl = new MintController(merged, root, id);
    await ctrl.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    try {
      const [projectRes, meRes] = await Promise.all([
        fetch(`${this.cfg.apiBase}/v1/projects/${this.projectId}`, {
          credentials: "include",
        }),
        fetch(`${this.cfg.apiBase}/v1/me`, { credentials: "include" }).catch(
          () => null,
        ),
      ]);
      if (!projectRes.ok) {
        this.root.innerHTML = `<div class="alert alert-danger">Project not found.</div>`;
        return;
      }
      const data = (await projectRes.json()) as {
        project: ProjectShape;
        owner: OwnerShape;
      };
      this.project = data.project;
      this.owner = data.owner;
      if (meRes && meRes.ok) {
        const me = (await meRes.json()) as {
          user: { id: number; handle: string };
        };
        this.viewer = { uid: me.user.id, handle: me.user.handle };
      }
      await this.loadChainState();
      this.render();
    } catch (e) {
      console.error(e);
      this.root.innerHTML = `<div class="alert alert-danger">Could not load project.</div>`;
    }
  }

  private async loadChainState(): Promise<void> {
    if (!this.project?.contract_address) {
      this.chainState = null;
      return;
    }
    try {
      const res = await fetch(
        `${this.cfg.apiBase}/v1/projects/${this.projectId}/mint/state`,
        { credentials: "include" },
      );
      if (!res.ok) return;
      const data = (await res.json()) as {
        cid_locked: boolean;
        total_minted: string | null;
        max_supply: string | null;
      };
      this.chainState = {
        cid_locked: data.cid_locked,
        total_minted: data.total_minted,
        max_supply: data.max_supply,
      };
    } catch (e) {
      console.warn("mint state fetch failed", e);
    }
  }

  private render(): void {
    if (!this.project || !this.owner) return;
    const tmpl = document.getElementById(
      "ga-mint-tmpl",
    ) as HTMLTemplateElement | null;
    if (!tmpl) return;
    const node = tmpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
    this.node = node;

    const status = node.querySelector("[data-ga-status]") as HTMLElement;
    const title = node.querySelector("[data-ga-title]") as HTMLElement;
    const desc = node.querySelector("[data-ga-description]") as HTMLElement;
    const ownerLink = node.querySelector(
      "[data-ga-owner-link]",
    ) as HTMLAnchorElement;
    const ownerHandle = node.querySelector(
      "[data-ga-owner-handle]",
    ) as HTMLElement;
    const chainEl = node.querySelector("[data-ga-chain]") as HTMLElement;
    const contractLink = node.querySelector(
      "[data-ga-contract-link]",
    ) as HTMLAnchorElement;
    const contractEl = node.querySelector("[data-ga-contract]") as HTMLElement;

    status.textContent = this.project.status.toUpperCase();
    title.textContent = this.project.title;
    desc.textContent = this.project.description ?? "";
    ownerLink.href = `/@${this.owner.handle}/`;
    ownerHandle.textContent = `@${this.owner.handle}`;

    const chainId = this.project.chain_id ?? 84532;
    chainEl.textContent = chainLabel(chainId);

    if (this.project.contract_address) {
      const addr = this.project.contract_address;
      contractEl.textContent = `${addr.slice(0, 6)}…${addr.slice(-4)}`;
      contractLink.href = `${basescanBase(chainId)}/address/${addr}`;
    } else {
      contractEl.textContent = "Not deployed";
      contractLink.removeAttribute("href");
    }

    // Live chain state — totalMinted / maxSupply / CID lock — read
    // from the deployed clone via the Worker's /mint/state endpoint.
    const mintedEl = node.querySelector(
      "[data-ga-minted]",
    ) as HTMLElement | null;
    if (mintedEl) {
      if (!this.chainState) {
        mintedEl.textContent = this.project.contract_address ? "—" : "—";
      } else {
        const max = this.chainState.max_supply;
        const supplyLabel = max && max !== "0" ? max : "open edition";
        mintedEl.textContent = `${this.chainState.total_minted ?? "0"} / ${supplyLabel}`;
      }
    }
    const lockedEl = node.querySelector(
      "[data-ga-cid-locked]",
    ) as HTMLElement | null;
    if (lockedEl) {
      lockedEl.textContent =
        this.chainState?.cid_locked ? "locked" : "unlocked";
    }

    this.root.replaceChildren(node);
    this.renderArt();
    this.bindActions();
    this.refreshChainState();
  }

  private renderArt(): void {
    if (!this.project?.frozen_cid) return;
    const iframe = document.getElementById(
      "ga-mint-iframe",
    ) as HTMLIFrameElement | null;
    if (!iframe) return;
    // Use a deterministic preview seed (project id) so the artwork is
    // visible before the user mints; once they mint, we re-point the
    // iframe at their freshly minted seed.
    const previewSeed =
      "0x" + this.project.id.toString(16).padStart(64, "0");
    iframe.src = `https://${this.project.frozen_cid}.ipfs.dweb.link/?seed=${previewSeed}`;
  }

  private bindActions(): void {
    const node = this.node!;
    const connect = node.querySelector(
      "[data-ga-connect]",
    ) as HTMLButtonElement;
    const deploy = node.querySelector("[data-ga-deploy]") as HTMLButtonElement;
    const lock = node.querySelector("[data-ga-lock]") as HTMLButtonElement;
    const mint = node.querySelector("[data-ga-mint]") as HTMLButtonElement;

    connect.addEventListener("click", () => this.connect());
    deploy.addEventListener("click", () =>
      this.runPhase("deploy", deploy),
    );
    lock.addEventListener("click", () => this.runPhase("lock_cid", lock));
    mint.addEventListener("click", () => this.runPhase("mint", mint));
  }

  private async connect(): Promise<void> {
    if (!window.ethereum) {
      this.feedback(
        "No injected wallet found. Install MetaMask or a Base-compatible wallet.",
      );
      return;
    }
    try {
      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as Address[];
      if (!accounts?.length) return;
      this.connectedAddress = getAddress(accounts[0]);
      this.wallet = createWalletClient({
        account: this.connectedAddress,
        transport: custom(window.ethereum),
      });
      const connectBtn = this.node!.querySelector(
        "[data-ga-connect]",
      ) as HTMLButtonElement;
      connectBtn.textContent = `Connected: ${this.connectedAddress.slice(0, 6)}…${this.connectedAddress.slice(-4)}`;
      connectBtn.disabled = true;
      this.refreshChainState();
    } catch (e) {
      this.feedback(`Wallet connect failed: ${(e as Error).message}`);
    }
  }

  private isOwnerViewing(): boolean {
    return (
      this.viewer !== null &&
      this.project !== null &&
      this.viewer.uid === this.project.owner_id
    );
  }

  private refreshChainState(): void {
    const node = this.node;
    if (!node || !this.project) return;
    const deploy = node.querySelector(
      "[data-ga-deploy]",
    ) as HTMLButtonElement;
    const lock = node.querySelector("[data-ga-lock]") as HTMLButtonElement;
    const mint = node.querySelector("[data-ga-mint]") as HTMLButtonElement;

    const owner = this.isOwnerViewing();
    const hasContract = !!this.project.contract_address;
    const connected = !!this.connectedAddress;

    const cidLocked = !!this.chainState?.cid_locked;
    const lockable = !!this.project.frozen_cid;

    deploy.classList.toggle("d-none", !(owner && !hasContract));
    lock.classList.toggle(
      "d-none",
      !(owner && hasContract && !cidLocked),
    );
    lock.disabled = !lockable;
    if (owner && hasContract && !cidLocked && !lockable) {
      // Surface why the lock button is disabled.
      this.feedback(
        "No frozen_cid set yet — pin a bundle to IPFS, then PATCH /v1/projects/{id} with frozen_cid before locking.",
      );
    }
    mint.classList.toggle(
      "d-none",
      !(connected && hasContract && cidLocked),
    );
  }

  private async runPhase(
    phase: "deploy" | "lock_cid" | "mint",
    button: HTMLButtonElement,
  ): Promise<void> {
    if (!this.connectedAddress || !this.wallet) {
      this.feedback("Connect a wallet first.");
      return;
    }
    button.disabled = true;
    const original = button.textContent;
    button.textContent = "Preparing…";
    try {
      const prepRes = await fetch(
        `${this.cfg.apiBase}/v1/projects/${this.projectId}/mint/prepare`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phase }),
        },
      );
      if (!prepRes.ok) {
        const err = (await prepRes.json().catch(() => ({}))) as {
          error?: string;
        };
        if (prepRes.status === 503 && err.error === "mint_unconfigured") {
          this.feedback(
            "Mint isn't configured yet — the GAProjectFactory hasn't been deployed to this chain.",
          );
          return;
        }
        this.feedback(`Prepare failed: ${err.error ?? prepRes.statusText}`);
        return;
      }
      const prep = (await prepRes.json()) as PreparePayload;

      // Make sure the wallet is on the right chain. Wallets reject txs
      // submitted to the wrong chain, so we proactively prompt the
      // user to switch.
      await this.ensureChain(prep.chain.id);

      // Simulate / estimate gas before asking the wallet to sign.
      // This catches reverts (e.g. CIDNotSet, MintLimitReached) and
      // surfaces a "you'll spend ~X gas" preview so the user knows
      // what they're signing.
      button.textContent = "Simulating…";
      const txParams = {
        from: this.connectedAddress,
        to: prep.to,
        data: prep.data,
        value: prep.value,
      };
      let estimatedGas: bigint | null = null;
      try {
        const gasHex = (await window.ethereum!.request({
          method: "eth_estimateGas",
          params: [txParams],
        })) as Hex;
        estimatedGas = BigInt(gasHex);
        this.feedback(
          `Simulation OK — estimated gas ${estimatedGas.toLocaleString()}.`,
        );
      } catch (e) {
        const reason = (e as Error).message || "unknown";
        this.feedback(`Simulation failed: ${reason}`);
        return;
      }

      button.textContent = "Awaiting wallet…";
      const txHash = (await window.ethereum!.request({
        method: "eth_sendTransaction",
        params: [txParams],
      })) as Hex;
      this.showTx(txHash, prep.chain.id);

      button.textContent = "Confirming on-chain…";
      const publicClient = this.publicClientFor(prep.chain);
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      });
      if (receipt.status !== "success") {
        this.feedback("Transaction reverted on-chain.");
        return;
      }

      if (phase === "deploy") {
        const cloneAddr = this.extractCloneAddress(receipt.logs);
        if (!cloneAddr) {
          this.feedback(
            "Deploy succeeded but ProjectCreated event was not found — please refresh.",
          );
          return;
        }
        const cdRes = await fetch(
          `${this.cfg.apiBase}/v1/projects/${this.projectId}/mint/confirm-deploy`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tx_hash: txHash }),
          },
        );
        if (!cdRes.ok) {
          const err = (await cdRes.json().catch(() => ({}))) as {
            error?: string;
          };
          this.feedback(
            `Deploy succeeded on-chain but server verification failed: ${err.error ?? cdRes.statusText}.`,
          );
          return;
        }
        this.feedback(
          `Deployed at ${cloneAddr.slice(0, 6)}…${cloneAddr.slice(-4)}.`,
        );
      } else if (phase === "lock_cid") {
        this.feedback("Frozen CID locked. Anyone can now mint.");
      } else if (phase === "mint") {
        const minted = this.extractMintedSeed(receipt.logs);
        if (minted) {
          this.swapPreviewSeed(minted.seed);
        }
        // Task #18: traits are NOT extracted client-side anymore —
        // they would arrive at confirm-mint as untrusted user input
        // and could be forged. The Worker persists the on-chain seed
        // and a trusted indexer (out of band) computes features from
        // it deterministically. Confirm-mint here just records the
        // mint row and flips status; rarity/trait surfaces fill in
        // once the indexer has run.
        await fetch(
          `${this.cfg.apiBase}/v1/projects/${this.projectId}/mint/confirm-mint`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tx_hash: txHash }),
          },
        );
        this.feedback("Minted! Token is in your wallet.");
      }

      // Reload project + chain state so the UI advances to the next phase.
      const refreshed = await fetch(
        `${this.cfg.apiBase}/v1/projects/${this.projectId}`,
        { credentials: "include" },
      );
      if (refreshed.ok) {
        const data = (await refreshed.json()) as {
          project: ProjectShape;
          owner: OwnerShape;
        };
        this.project = data.project;
        this.owner = data.owner;
        await this.loadChainState();
        this.render();
      }
    } catch (e) {
      this.feedback(`Failed: ${(e as Error).message}`);
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  private async ensureChain(targetChainId: number): Promise<void> {
    if (!window.ethereum) return;
    const current = (await window.ethereum.request({
      method: "eth_chainId",
    })) as Hex;
    if (parseInt(current, 16) === targetChainId) return;
    const targetHex = ("0x" + targetChainId.toString(16)) as Hex;
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: targetHex }],
      });
    } catch (err: unknown) {
      // Chain not in the wallet yet — try to add Base Sepolia.
      const code = (err as { code?: number })?.code;
      if (code === 4902 && targetChainId === 84532) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: targetHex,
              chainName: "Base Sepolia",
              nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
              rpcUrls: ["https://sepolia.base.org"],
              blockExplorerUrls: ["https://sepolia.basescan.org"],
            },
          ],
        });
      } else {
        throw err;
      }
    }
  }

  private publicClientFor(chain: ChainInfo): PublicClient {
    return createPublicClient({ transport: http(chain.rpcUrl) });
  }

  private extractCloneAddress(
    logs: { address: string; topics: readonly Hex[]; data: Hex }[],
  ): Address | null {
    for (const log of logs) {
      try {
        const decoded = decodeEventLog({
          abi: [PROJECT_CREATED],
          topics: log.topics as [Hex, ...Hex[]],
          data: log.data,
        });
        if (decoded.eventName === "ProjectCreated") {
          return getAddress(decoded.args.project as Address);
        }
      } catch {
        /* not our event */
      }
    }
    return null;
  }

  private extractMintedSeed(
    logs: { address: string; topics: readonly Hex[]; data: Hex }[],
  ): { tokenId: bigint; seed: Hex } | null {
    for (const log of logs) {
      try {
        const decoded = decodeEventLog({
          abi: [MINTED],
          topics: log.topics as [Hex, ...Hex[]],
          data: log.data,
        });
        if (decoded.eventName === "Minted") {
          return {
            tokenId: decoded.args.tokenId as bigint,
            seed: decoded.args.seed as Hex,
          };
        }
      } catch {
        /* not our event */
      }
    }
    return null;
  }

  /**
   * Ask the active preview iframe to evaluate `window.$features(seed)`
   * for the freshly-minted seed and return the trait map. The iframe
   * already has the artist's sketch loaded (we point it there in
   * `renderArt`); we just need it to sandbox the call. Resolves to
   * null if the iframe isn't ready, the function isn't defined, or
   * the call times out — confirm-mint then proceeds with no traits.
   *
   * Note: the live preview iframe points at the IPFS gateway, which
   * loads the *frozen* bundle, not the studio dev preview. The
   * features() function lives inside the frozen bundle's index.html
   * and is reachable via the same postMessage protocol that the
   * studio sandbox speaks (we ship it with every bundle).
   */
  private async extractFeaturesForSeed(
    seed: Hex,
  ): Promise<Record<string, string> | null> {
    const iframe = document.getElementById(
      "ga-mint-iframe",
    ) as HTMLIFrameElement | null;
    if (!iframe || !iframe.contentWindow) return null;
    const requestId = `feat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return await new Promise<Record<string, string> | null>((resolve) => {
      const timer = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve(null);
      }, 1500);
      function onMessage(ev: MessageEvent) {
        const d = ev.data as
          | {
              type?: string;
              requestId?: string;
              ok?: boolean;
              features?: Record<string, string>;
            }
          | null;
        if (!d || d.type !== "studio:features" || d.requestId !== requestId) {
          return;
        }
        window.clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        if (d.ok && d.features) resolve(d.features);
        else resolve(null);
      }
      window.addEventListener("message", onMessage);
      try {
        iframe.contentWindow!.postMessage(
          { type: "studio:extractFeatures", seed, requestId },
          "*",
        );
      } catch {
        window.clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(null);
      }
    });
  }

  private swapPreviewSeed(seed: Hex): void {
    if (!this.project?.frozen_cid) return;
    const iframe = document.getElementById(
      "ga-mint-iframe",
    ) as HTMLIFrameElement | null;
    if (!iframe) return;
    iframe.src = `https://${this.project.frozen_cid}.ipfs.dweb.link/?seed=${seed}`;
  }

  private showTx(txHash: Hex, chainId: number): void {
    const region = this.node!.querySelector(
      "[data-ga-tx-region]",
    ) as HTMLElement;
    const link = this.node!.querySelector(
      "[data-ga-tx-link]",
    ) as HTMLAnchorElement;
    const label = this.node!.querySelector("[data-ga-tx]") as HTMLElement;
    region.classList.remove("d-none");
    link.href = `${basescanBase(chainId)}/tx/${txHash}`;
    label.textContent = `${txHash.slice(0, 10)}…${txHash.slice(-6)}`;
  }

  private feedback(msg: string): void {
    const el = this.node?.querySelector(
      "[data-ga-feedback]",
    ) as HTMLElement | null;
    if (el) el.textContent = msg;
  }
}

const GAMint = {
  start: (cfg?: Partial<MintConfig>) => MintController.start(cfg),
};

window.GAMint = GAMint;

// No auto-start: /mint/index.html computes the right apiBase
// (localhost for dev, https://api.generatedart.com for prod) and
// calls GAMint.start() explicitly, mirroring /p/index.html.

export {};
