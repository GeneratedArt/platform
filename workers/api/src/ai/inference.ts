import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../types";
import type { ModelKind, ModelProvider } from "../db/render";

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
}

export interface InferenceOutput {
  outputKind: "code" | "image";
  /** Present for `code` jobs — the generated source, inline. */
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
 * Cloudflare Workers AI — image generation (reference art / textures).
 * Output feeds the studio's working material only; it is never eligible
 * for the frozen-artifact bundle (enforced in the freeze pipeline, not
 * here — this function just runs the model).
 */
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
  let result: unknown;
  try {
    result = await env.AI.run(input.providerModelId, {
      prompt: input.prompt,
      seed: /^\d+$/.test(input.seed) ? parseInt(input.seed, 10) : undefined,
    });
  } catch (e) {
    throw new InferenceError(
      e instanceof Error ? e.message : "workers ai request failed",
      "provider_error",
    );
  }
  // Workers AI image models return a ReadableStream (binary) response.
  let bytes: Uint8Array;
  if (result instanceof ReadableStream) {
    const buf = await new Response(result).arrayBuffer();
    bytes = new Uint8Array(buf);
  } else if (result instanceof Uint8Array) {
    bytes = result;
  } else {
    throw new InferenceError(
      "unexpected Workers AI response shape",
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
