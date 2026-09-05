import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../types";
import type { ModelKind, ModelProvider } from "../db/render";
import { getCatalogueEntry, type CatalogueEntry } from "./workersAiCatalogue";

/**
 * Model-execution layer for the render-token service.
 *
 * Every provider returns the SAME shape so the render handler never
 * branches on provider after this call. `outputHash` is sha256 of the
 * bytes actually returned — it's what render_jobs.output_hash records,
 * so two jobs with the same model version + params + seed can be
 * compared for reproducibility without re-running anything.
 */

export interface InferenceInput {
  kind: ModelKind;
  provider: ModelProvider;
  providerModelId: string;
  systemPrompt: string | null;
  /** User-supplied instruction/prompt for this run. */
  prompt: string;
  params: Record<string, unknown> | null;
  /** Deterministic seed threaded into the provider call where supported. */
  seed: string;
  /**
   * fal_custom only: the trained model/LoRA identifier at the provider
   * (render_model_versions.weights_ref). Absent for every other
   * provider.
   */
  weightsRef?: string | null;
  /**
   * Source image for the img2img / inpaint / vision lanes. Raw bytes —
   * the adapter converts to whatever encoding the target model wants.
   */
  sourceImage?: Uint8Array | null;
  /** Inpainting mask. Required by the inpaint family, ignored elsewhere. */
  maskImage?: Uint8Array | null;
}

export interface InferenceOutput {
  /**
   * `text` covers the companion lane (vision reverse-prompting, prompt
   * expansion). Deliberately NOT added to `ModelKind` — companion
   * models are an internal assist, not something a creator publishes.
   */
  outputKind: "code" | "image" | "text";
  /** Present for `code` and `text` jobs — the generated text, inline. */
  text: string | null;
  /** Present for `image` jobs — raw bytes for the caller to persist to R2. */
  bytes: Uint8Array | null;
  contentType: string | null;
  outputHash: string;
}

export class InferenceError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Whether mock mode is active. OPT-IN ONLY, mirrors PINNING_MOCK /
 * GITHUB_MOCK: production must never set RENDER_MOCK. A missing
 * ANTHROPIC_API_KEY does NOT enable mock mode — the anthropic provider
 * fails closed with `provider_unconfigured` instead.
 */
export function isRenderMock(env: Env): boolean {
  return env.RENDER_MOCK === "1";
}

/**
 * Deterministic canned output for dev/tests. Reproducible from
 * (providerModelId, prompt, seed) alone — no network, no randomness —
 * so scripts/smoke_api.mjs and local `wrangler dev` runs are hermetic.
 */
async function runMock(input: InferenceInput): Promise<InferenceOutput> {
  // Companion (vision / instruct) models return text, and are reached by
  // provider model id rather than by ModelKind — so the mock has to look
  // them up the same way the real path does, or mock runs would claim an
  // image where production returns prose.
  const mockEntry =
    input.provider === "workers_ai"
      ? getCatalogueEntry(input.providerModelId)
      : undefined;
  if (mockEntry?.outputKind === "text") {
    const text =
      `mock ${mockEntry.family} output — model=${mockEntry.id} ` +
      `seed=${input.seed}: ${input.prompt.slice(0, 120)}`;
    const outputHash = await sha256Hex(new TextEncoder().encode(text));
    return { outputKind: "text", text, bytes: null, contentType: null, outputHash };
  }
  if (input.kind === "code") {
    const text =
      `// mock render — provider=${input.provider} model=${input.providerModelId}\n` +
      `// seed=${input.seed}\n` +
      `function setup() { createCanvas(400, 400); }\n` +
      `function draw() { background(0); }\n` +
      `// prompt: ${input.prompt.slice(0, 120)}\n`;
    const outputHash = await sha256Hex(new TextEncoder().encode(text));
    return { outputKind: "code", text, bytes: null, contentType: null, outputHash };
  }
  // A tiny valid 1x1 PNG, identical for every mock image job. Real
  // pixels aren't the point of the mock path — reachability is.
  const onePxPng = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    ),
    (c) => c.charCodeAt(0),
  );
  const outputHash = await sha256Hex(onePxPng);
  return {
    outputKind: "image",
    text: null,
    bytes: onePxPng,
    contentType: "image/png",
    outputHash,
  };
}

/**
 * Claude API — code generation.
 *
 * Uses the official Anthropic SDK per this workspace's convention.
 * The determinism contract lives in the system prompt: the model is
 * instructed to write self-contained p5.js/three.js code with no
 * network calls and no non-seeded randomness — the same discipline the
 * frozen-artifact pipeline already requires of every minted sketch.
 */
async function runAnthropic(
  env: Env,
  input: InferenceInput,
): Promise<InferenceOutput> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new InferenceError(
      "ANTHROPIC_API_KEY is not configured",
      "provider_unconfigured",
    );
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const determinism =
    "Output only self-contained JavaScript for p5.js or three.js. " +
    "No network calls, no external imports, no Date.now() or Math.random() " +
    "— use the numeric seed given below for any randomness. Return code only, " +
    "no prose, no markdown fences.";
  const system = [input.systemPrompt, determinism].filter(Boolean).join("\n\n");
  const userMessage =
    `Seed: ${input.seed}\n` +
    (input.params ? `Params: ${JSON.stringify(input.params)}\n` : "") +
    `Instruction: ${input.prompt}`;

  let message;
  try {
    message = await client.messages.create({
      model: input.providerModelId,
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: userMessage }],
      thinking: { type: "adaptive" },
    });
  } catch (e) {
    throw new InferenceError(
      e instanceof Error ? e.message : "anthropic request failed",
      "provider_error",
    );
  }
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) {
    throw new InferenceError("empty response from model", "provider_error");
  }
  const outputHash = await sha256Hex(new TextEncoder().encode(text));
  return { outputKind: "code", text, bytes: null, contentType: null, outputHash };
}

/**
 * Cloudflare Workers AI.
 *
 * Dispatches on the catalogue entry rather than assuming one shape:
 * Workers AI models disagree on both request and response format, and
 * the disagreement does not follow vendor or task (see the header of
 * ./workersAiCatalogue.ts). An unlisted model is refused here rather
 * than being forwarded to `env.AI.run()` on trust.
 *
 * Image output feeds the studio's working material only; it is never
 * eligible for the frozen-artifact bundle (enforced in the freeze
 * pipeline, not here — this function just runs the model).
 */

/** Decode a base64 string into bytes. */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

/**
 * Caller params, narrowed to the keys this model accepts. Unknown keys
 * are dropped: some models reject them and others ignore them silently,
 * and a caller should not be able to discover which by experiment.
 */
export function filterParams(
  entry: CatalogueEntry,
  params: Record<string, unknown> | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...entry.defaults };
  if (!params) return out;
  for (const key of entry.paramAllowlist) {
    if (params[key] !== undefined) out[key] = params[key];
  }
  return out;
}

/** Numeric seed where the seed is numeric; undefined otherwise. */
function numericSeed(seed: string): number | undefined {
  return /^\d+$/.test(seed) ? parseInt(seed, 10) : undefined;
}

/**
 * Build the JSON body for a model. Families differ in more than
 * parameters: the SD lanes want pixel arrays, vision wants an image
 * alongside a prompt, and instruct wants a chat transcript.
 */
export function buildJsonInput(
  entry: CatalogueEntry,
  input: InferenceInput,
): Record<string, unknown> {
  const params = filterParams(entry, input.params);
  const seed = numericSeed(input.seed);

  if (entry.family === "instruct") {
    const messages: { role: string; content: string }[] = [];
    if (input.systemPrompt) {
      messages.push({ role: "system", content: input.systemPrompt });
    }
    messages.push({ role: "user", content: input.prompt });
    return { ...params, messages };
  }

  if (entry.family === "vision") {
    if (!input.sourceImage) {
      throw new InferenceError(
        `${entry.label} requires a source image`,
        "missing_source_image",
      );
    }
    return { ...params, prompt: input.prompt, image: Array.from(input.sourceImage) };
  }

  const body: Record<string, unknown> = { ...params, prompt: input.prompt };
  if (seed !== undefined) body.seed = seed;

  if (entry.family === "img2img" || entry.family === "inpaint") {
    if (!input.sourceImage) {
      throw new InferenceError(
        `${entry.label} requires a source image`,
        "missing_source_image",
      );
    }
    // Documented as an array of 8-bit unsigned integers, not raw bytes.
    body.image = Array.from(input.sourceImage);
  }
  if (entry.family === "inpaint") {
    if (!input.maskImage) {
      throw new InferenceError(
        `${entry.label} requires a mask`,
        "missing_mask",
      );
    }
    body.mask = Array.from(input.maskImage);
  }
  return body;
}

/**
 * FLUX.2 models take multipart form-data even for a prompt-only call.
 * FormData exposes neither its serialized body nor its boundary, so it
 * is round-tripped through a Response to get both.
 */
function buildMultipartInput(
  entry: CatalogueEntry,
  input: InferenceInput,
): { multipart: { body: unknown; contentType: string } } {
  const params = filterParams(entry, input.params);
  const seed = numericSeed(input.seed);
  const form = new FormData();
  form.append("prompt", input.prompt);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) form.append(key, String(value));
  }
  if (seed !== undefined) form.append("seed", String(seed));
  if (input.sourceImage) {
    form.append(
      "input_image_0",
      new Blob([input.sourceImage], { type: "image/png" }),
    );
  }
  const serialized = new Response(form);
  const contentType = serialized.headers.get("content-type");
  if (!contentType) {
    throw new InferenceError("could not serialize multipart body", "provider_error");
  }
  return { multipart: { body: serialized.body, contentType } };
}

/**
 * Decode whatever the model returned into bytes or text, per the
 * catalogue's declared response shape.
 */
export async function decodeOutput(
  entry: CatalogueEntry,
  result: unknown,
): Promise<{ bytes: Uint8Array | null; text: string | null }> {
  if (entry.responseShape === "binary") {
    if (result instanceof ReadableStream) {
      const buf = await new Response(result as ReadableStream).arrayBuffer();
      return { bytes: new Uint8Array(buf), text: null };
    }
    if (result instanceof Uint8Array) return { bytes: result, text: null };
    if (result instanceof ArrayBuffer) {
      return { bytes: new Uint8Array(result), text: null };
    }
    throw new InferenceError(
      `${entry.id} did not return binary output`,
      "provider_error",
    );
  }

  if (entry.responseShape === "json_base64_image") {
    const image = (result as { image?: unknown } | null)?.image;
    if (typeof image !== "string" || !image) {
      throw new InferenceError(
        `${entry.id} did not return a base64 image`,
        "provider_error",
      );
    }
    return { bytes: base64ToBytes(image), text: null };
  }

  // json_text
  const field = entry.textField ?? "response";
  const value = (result as Record<string, unknown> | null)?.[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new InferenceError(
      `${entry.id} did not return text in "${field}"`,
      "provider_error",
    );
  }
  return { bytes: null, text: value.trim() };
}

async function runWorkersAi(
  env: Env,
  input: InferenceInput,
): Promise<InferenceOutput> {
  if (!env.AI) {
    throw new InferenceError(
      "Workers AI binding is not configured",
      "provider_unconfigured",
    );
  }
  const entry = getCatalogueEntry(input.providerModelId);
  if (!entry) {
    throw new InferenceError(
      `${input.providerModelId} is not an allowlisted Workers AI model`,
      "model_not_in_catalogue",
    );
  }

  const body =
    entry.requestShape === "multipart"
      ? buildMultipartInput(entry, input)
      : buildJsonInput(entry, input);

  let result: unknown;
  try {
    // The binding's per-model overloads can't be satisfied by a model id
    // only known at runtime; the catalogue is what guarantees the body
    // matches the model.
    result = await (env.AI as unknown as {
      run(model: string, body: unknown): Promise<unknown>;
    }).run(entry.id, body);
  } catch (e) {
    throw new InferenceError(
      e instanceof Error ? e.message : "workers ai request failed",
      "provider_error",
    );
  }

  const { bytes, text } = await decodeOutput(entry, result);

  if (entry.outputKind === "text") {
    const outputHash = await sha256Hex(new TextEncoder().encode(text ?? ""));
    return { outputKind: "text", text, bytes: null, contentType: null, outputHash };
  }
  if (!bytes) {
    throw new InferenceError(`${entry.id} returned no image bytes`, "provider_error");
  }
  const outputHash = await sha256Hex(bytes);
  return {
    outputKind: "image",
    text: null,
    bytes,
    contentType: entry.contentType,
    outputHash,
  };
}

/**
 * fal.ai — creator-trained custom art models (fine-tune / LoRA on a
 * diffusion base). This is the one lane Workers AI can't serve: its
 * LoRA fine-tuning only accepts text model_types (mistral/gemma/llama),
 * so a coder's own trained checkpoint runs through fal.ai's private-
 * model inference instead — pay-per-run, no idle GPU cost, matching the
 * budget stance behind the rest of this stack.
 *
 * Raw HTTP, not an SDK: fal.ai has no first-party client bundled here
 * and the request shape is stable and small enough not to warrant one.
 * `weightsRef` is `render_model_versions.weights_ref` — the model or
 * LoRA identifier the creator registered when they published the
 * version — and is REQUIRED; there is no catalogue fallback for this
 * provider the way `provider_model_id` alone is enough for the others.
 */
async function runFalCustom(
  env: Env,
  input: InferenceInput,
): Promise<InferenceOutput> {
  if (!env.FAL_KEY) {
    throw new InferenceError("FAL_KEY is not configured", "provider_unconfigured");
  }
  if (!input.weightsRef) {
    throw new InferenceError(
      "fal_custom model version has no weights_ref",
      "model_misconfigured",
    );
  }
  let res: Response;
  try {
    res = await fetch(`https://fal.run/${input.providerModelId}`, {
      method: "POST",
      headers: {
        Authorization: `Key ${env.FAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: input.prompt,
        loras: [{ path: input.weightsRef }],
        seed: /^\d+$/.test(input.seed) ? parseInt(input.seed, 10) : undefined,
        ...(input.params ?? {}),
      }),
    });
  } catch (e) {
    throw new InferenceError(
      e instanceof Error ? e.message : "fal request failed",
      "provider_error",
    );
  }
  if (!res.ok) {
    throw new InferenceError(`fal request failed: ${res.status}`, "provider_error");
  }
  const data = (await res.json()) as { images?: { url?: string }[] };
  const imageUrl = data.images?.[0]?.url;
  if (!imageUrl) {
    throw new InferenceError("fal response had no image url", "provider_error");
  }
  let bytes: Uint8Array;
  try {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) throw new Error(`fetch image failed: ${imgRes.status}`);
    bytes = new Uint8Array(await imgRes.arrayBuffer());
  } catch (e) {
    throw new InferenceError(
      e instanceof Error ? e.message : "fal image fetch failed",
      "provider_error",
    );
  }
  const outputHash = await sha256Hex(bytes);
  return {
    outputKind: "image",
    text: null,
    bytes,
    contentType: "image/png",
    outputHash,
  };
}

export async function runInference(
  env: Env,
  input: InferenceInput,
): Promise<InferenceOutput> {
  if (isRenderMock(env)) return runMock(input);
  if (input.provider === "anthropic") return runAnthropic(env, input);
  if (input.provider === "workers_ai") return runWorkersAi(env, input);
  if (input.provider === "fal_custom") return runFalCustom(env, input);
  throw new InferenceError(`unsupported provider: ${input.provider}`, "provider_unconfigured");
}
