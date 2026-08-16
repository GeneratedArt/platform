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

export async function runInference(
  env: Env,
  input: InferenceInput,
): Promise<InferenceOutput> {
  if (isRenderMock(env)) return runMock(input);
  if (input.provider === "anthropic") return runAnthropic(env, input);
  if (input.provider === "workers_ai") return runWorkersAi(env, input);
  throw new InferenceError(`unsupported provider: ${input.provider}`, "provider_unconfigured");
}
