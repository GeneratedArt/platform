/**
 * Allowlisted Cloudflare Workers AI models, and the shape of each one.
 *
 * Workers AI models do NOT share a request or response contract, and the
 * differences are not inferable from vendor or task:
 *
 *   - `flux-1-schnell` takes `steps` and returns JSON `{ image: <base64> }`.
 *   - The Stable-Diffusion family takes `num_steps` and returns a raw
 *     `ReadableStream`.
 *   - `flux-2-*` take multipart form-data, even for a prompt-only call.
 *   - Leonardo's two models disagree with each other: `phoenix-1.0`
 *     streams bytes, `lucid-origin` returns base64 JSON.
 *
 * So the shape is recorded per model rather than guessed at call time.
 * Every row here was checked against
 * https://developers.cloudflare.com/workers-ai/models/<name>/ — when
 * adding a model, check its page rather than copying a neighbouring row.
 *
 * This table is also the registration allowlist: `provider_model_id` was
 * previously any free-form string passed straight to `env.AI.run()`, so a
 * typo or an unpriced model only failed after a user had been charged.
 */

export type WorkersAiFamily =
  | "text2img"
  | "img2img"
  | "inpaint"
  | "vision"
  | "instruct";

/** How the request body is built. */
export type RequestShape = "json" | "multipart";

/** How the response is decoded. */
export type ResponseShape = "binary" | "json_base64_image" | "json_text";

export interface CatalogueEntry {
  id: string;
  label: string;
  family: WorkersAiFamily;
  requestShape: RequestShape;
  responseShape: ResponseShape;
  outputKind: "image" | "text";
  /** Null for text models — they produce no stored artifact. */
  contentType: string | null;
  /** Applied before caller params; caller may override allowlisted keys. */
  defaults: Readonly<Record<string, unknown>>;
  /**
   * Caller-supplied params forwarded to the model. Anything else is
   * dropped — an unknown key is rejected by some models and silently
   * ignored by others, and neither is a good failure mode.
   */
  paramAllowlist: readonly string[];
  /** Which JSON field carries the text, for `json_text` responses. */
  textField?: "response" | "description";
  /**
   * RELATIVE cost weight, cheapest = 1. A deliberate placeholder: real
   * per-model pricing is published per model page (and is variously
   * per-step, per-512px-tile, or both), so these are an ordering for the
   * billing layer to reason about, NOT dollar amounts. Substitute real
   * figures from https://developers.cloudflare.com/workers-ai/platform/pricing/
   * before charging against them.
   */
  costUnits: number;
}

/** Stable-Diffusion-family params — shared by every `@cf` SD derivative. */
const SD_PARAMS = [
  "negative_prompt",
  "height",
  "width",
  "num_steps",
  "guidance",
  "seed",
] as const;

const ENTRIES: readonly CatalogueEntry[] = [
  // ---- Draft / real-time -------------------------------------------------
  {
    id: "@cf/black-forest-labs/flux-1-schnell",
    label: "FLUX.1 [schnell]",
    family: "text2img",
    requestShape: "json",
    // Returns { image: "<base64 jpeg>" } — NOT a stream. This is the case
    // the previous single-path implementation threw on.
    responseShape: "json_base64_image",
    outputKind: "image",
    contentType: "image/jpeg",
    defaults: { steps: 4 },
    paramAllowlist: ["steps", "seed"],
    costUnits: 1,
  },
  {
    id: "@cf/bytedance/stable-diffusion-xl-lightning",
    label: "SDXL Lightning",
    family: "text2img",
    requestShape: "json",
    responseShape: "binary",
    outputKind: "image",
    contentType: "image/png",
    defaults: { num_steps: 4 },
    paramAllowlist: SD_PARAMS,
    costUnits: 1,
  },
  {
    id: "@cf/lykon/dreamshaper-8-lcm",
    label: "DreamShaper 8 LCM",
    family: "text2img",
    requestShape: "json",
    responseShape: "binary",
    outputKind: "image",
    contentType: "image/png",
    defaults: { num_steps: 8 },
    paramAllowlist: SD_PARAMS,
    costUnits: 1,
  },
  {
    id: "@cf/black-forest-labs/flux-2-klein-4b",
    label: "FLUX.2 [klein] 4B",
    family: "text2img",
    // Multipart form-data even for a prompt-only call.
    requestShape: "multipart",
    responseShape: "json_base64_image",
    outputKind: "image",
    contentType: "image/jpeg",
    // Distilled: `steps` is fixed at 4 upstream and cannot be adjusted.
    defaults: { width: 1024, height: 1024 },
    paramAllowlist: ["width", "height", "guidance", "seed"],
    costUnits: 2,
  },

  // ---- Final / high fidelity --------------------------------------------
  {
    id: "@cf/black-forest-labs/flux-2-klein-9b",
    label: "FLUX.2 [klein] 9B",
    family: "text2img",
    requestShape: "multipart",
    responseShape: "json_base64_image",
    outputKind: "image",
    contentType: "image/jpeg",
    defaults: { width: 1024, height: 1024 },
    paramAllowlist: ["width", "height", "guidance", "seed"],
    costUnits: 4,
  },
  {
    id: "@cf/black-forest-labs/flux-2-dev",
    label: "FLUX.2 [dev]",
    family: "text2img",
    requestShape: "multipart",
    responseShape: "json_base64_image",
    outputKind: "image",
    contentType: "image/jpeg",
    defaults: { width: 1024, height: 768 },
    paramAllowlist: ["width", "height", "guidance", "seed", "steps"],
    costUnits: 8,
  },
  {
    id: "@cf/leonardo/phoenix-1.0",
    label: "Leonardo Phoenix 1.0",
    family: "text2img",
    requestShape: "json",
    // Leonardo's two models differ from each other — phoenix streams.
    responseShape: "binary",
    outputKind: "image",
    contentType: "image/png",
    defaults: { num_steps: 25, guidance: 2, width: 1024, height: 1024 },
    paramAllowlist: ["num_steps", "guidance", "seed", "width", "height", "negative_prompt"],
    costUnits: 6,
  },
  {
    id: "@cf/leonardo/lucid-origin",
    label: "Leonardo Lucid Origin",
    family: "text2img",
    requestShape: "json",
    // ...while lucid-origin returns base64 JSON.
    responseShape: "json_base64_image",
    outputKind: "image",
    contentType: "image/jpeg",
    defaults: { num_steps: 25, guidance: 4.5, width: 1120, height: 1120 },
    paramAllowlist: ["num_steps", "steps", "guidance", "seed", "width", "height"],
    costUnits: 6,
  },
  {
    id: "@cf/stabilityai/stable-diffusion-xl-base-1.0",
    label: "Stable Diffusion XL 1.0",
    family: "text2img",
    requestShape: "json",
    responseShape: "binary",
    outputKind: "image",
    contentType: "image/png",
    defaults: { num_steps: 20 },
    paramAllowlist: SD_PARAMS,
    costUnits: 3,
  },

  // ---- Edit / remix ------------------------------------------------------
  {
    id: "@cf/runwayml/stable-diffusion-v1-5-img2img",
    label: "SD 1.5 img2img",
    family: "img2img",
    requestShape: "json",
    responseShape: "binary",
    outputKind: "image",
    contentType: "image/png",
    defaults: { num_steps: 20, strength: 1 },
    paramAllowlist: [...SD_PARAMS, "strength"],
    costUnits: 2,
  },
  {
    id: "@cf/runwayml/stable-diffusion-v1-5-inpainting",
    label: "SD 1.5 inpainting",
    family: "inpaint",
    requestShape: "json",
    responseShape: "binary",
    outputKind: "image",
    contentType: "image/png",
    defaults: { num_steps: 20, strength: 1 },
    paramAllowlist: [...SD_PARAMS, "strength"],
    costUnits: 2,
  },

  // ---- Companion: vision (reverse-prompt, critique) ----------------------
  {
    id: "@cf/meta/llama-3.2-11b-vision-instruct",
    label: "Llama 3.2 11B Vision",
    family: "vision",
    requestShape: "json",
    responseShape: "json_text",
    outputKind: "text",
    contentType: null,
    defaults: { max_tokens: 512 },
    paramAllowlist: ["max_tokens", "temperature"],
    textField: "response",
    costUnits: 1,
  },
  {
    id: "@cf/llava-hf/llava-1.5-7b-hf",
    label: "LLaVA 1.5 7B",
    family: "vision",
    requestShape: "json",
    responseShape: "json_text",
    outputKind: "text",
    contentType: null,
    defaults: { max_tokens: 512 },
    paramAllowlist: ["max_tokens", "temperature"],
    // LLaVA returns `description` rather than `response`.
    textField: "description",
    costUnits: 1,
  },

  // ---- Companion: instruct (prompt expansion) ----------------------------
  {
    id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    label: "Llama 3.3 70B Instruct (fp8)",
    family: "instruct",
    requestShape: "json",
    responseShape: "json_text",
    outputKind: "text",
    contentType: null,
    defaults: { max_tokens: 1024 },
    paramAllowlist: ["max_tokens", "temperature"],
    textField: "response",
    costUnits: 2,
  },
  {
    id: "@cf/qwen/qwen2.5-coder-32b-instruct",
    label: "Qwen2.5 Coder 32B",
    family: "instruct",
    requestShape: "json",
    responseShape: "json_text",
    outputKind: "text",
    contentType: null,
    defaults: { max_tokens: 1024 },
    paramAllowlist: ["max_tokens", "temperature"],
    textField: "response",
    costUnits: 2,
  },
] as const;

const BY_ID = new Map<string, CatalogueEntry>(ENTRIES.map((e) => [e.id, e]));

export function getCatalogueEntry(id: string): CatalogueEntry | undefined {
  return BY_ID.get(id);
}

export function isCatalogueModel(id: string): boolean {
  return BY_ID.has(id);
}

/** Every allowlisted id — used in the registration error to say what IS allowed. */
export function catalogueModelIds(): string[] {
  return ENTRIES.map((e) => e.id);
}

/** Models a creator may publish: the image lanes, not the internal companions. */
export function publishableModelIds(): string[] {
  return ENTRIES.filter((e) => e.outputKind === "image").map((e) => e.id);
}
