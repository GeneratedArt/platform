import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../types";

/**
 * Studio Copilot — the platform's own built-in code assistant, distinct
 * from the render-model marketplace (src/ai/inference.ts / db/render.ts).
 * A model registry entry is a creator-published, token-metered product
 * someone else can render; the copilot is a fixed platform feature tied
 * to a project's own code in the Studio editor. Both call Claude, but
 * they're separate surfaces on purpose — publishing a model is a
 * creative act with its own provenance and earnings; asking the
 * copilot to edit YOUR sketch is not.
 *
 * Calls debit the same render-token ledger (one currency platform-wide,
 * not two parallel ones) — see projects/ai.ts for the debit/refund
 * wiring. This module only knows how to call Claude.
 *
 * SIMPLIFICATION, stated plainly rather than silently under-delivered:
 * `editSketch` returns the full revised source, not a per-hunk unified
 * diff. A true reviewable-hunks UI (as sketched in the design brief)
 * needs a diff-rendering library on the client that isn't in this
 * project's dependencies yet; shipping a fabricated "diff" that's
 * actually a whole-file replacement dressed up as hunks would be worse
 * than being upfront that v1 is accept-or-reject-the-whole-suggestion.
 */

export class CopilotError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
  }
}

function isAiMock(env: Env): boolean {
  return env.AI_MOCK === "1";
}

const DETERMINISM_RULE =
  "Output only self-contained JavaScript for the given engine (p5.js, " +
  "three.js, a GLSL shader harness, or plain canvas). No network calls, " +
  "no external imports, no Date.now() or Math.random() for anything that " +
  "affects the rendered output — use a seeded PRNG if randomness is " +
  "needed. Return code only: no prose, no markdown fences.";

async function complete(
  env: Env,
  system: string,
  userMessage: string,
): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new CopilotError("ANTHROPIC_API_KEY is not configured", "provider_unconfigured");
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  let message;
  try {
    message = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: userMessage }],
      thinking: { type: "adaptive" },
    });
  } catch (e) {
    throw new CopilotError(
      e instanceof Error ? e.message : "anthropic request failed",
      "provider_error",
    );
  }
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) throw new CopilotError("empty response from model", "provider_error");
  return text;
}

const MOCK_SKETCH = (engine: string, prompt: string) =>
  `// mock generate — engine=${engine}\n` +
  `// prompt: ${prompt.slice(0, 120)}\n` +
  `function setup() { createCanvas(400, 400); }\n` +
  `function draw() { background(0); }\n`;

/** POST /v1/projects/:id/ai/generate — a new sketch from a prompt. */
export async function generateSketch(
  env: Env,
  input: { engine: string; prompt: string },
): Promise<string> {
  if (isAiMock(env)) return MOCK_SKETCH(input.engine, input.prompt);
  const system =
    `You write ${input.engine} generative-art sketches for creative coders. ${DETERMINISM_RULE}`;
  return complete(env, system, input.prompt);
}

/** POST /v1/projects/:id/ai/edit — revise existing code per an instruction. */
export async function editSketch(
  env: Env,
  input: { engine: string; currentCode: string; instruction: string },
): Promise<string> {
  if (isAiMock(env)) {
    return `${input.currentCode}\n// mock edit: ${input.instruction.slice(0, 80)}\n`;
  }
  const system =
    `You edit ${input.engine} generative-art sketches for creative coders. ` +
    `You are given the current source and an instruction; return the FULL ` +
    `revised source, not a diff or partial snippet. ${DETERMINISM_RULE}`;
  const userMessage = `Current code:\n${input.currentCode}\n\nInstruction: ${input.instruction}`;
  return complete(env, system, userMessage);
}

/** POST /v1/projects/:id/ai/explain — plain-language walkthrough of code. */
export async function explainSketch(env: Env, code: string): Promise<string> {
  if (isAiMock(env)) return "mock explanation: this sketch sets up a canvas and draws a background.";
  const system =
    "Explain the given generative-art sketch's code in plain language for " +
    "an artist who codes but didn't write this particular sketch. Cover " +
    "what it draws, what varies per run (seed/randomness), and any " +
    "tunable-looking constants. Prose only, no code blocks.";
  return complete(env, system, code);
}

export interface ParamGuess {
  name: string;
  kind: "number" | "string" | "boolean";
  default: unknown;
  line_hint: string;
}

/** POST /v1/projects/:id/ai/params — guess tunable parameters from code. */
export async function extractParams(env: Env, code: string): Promise<ParamGuess[]> {
  if (isAiMock(env)) {
    return [{ name: "particleCount", kind: "number", default: 200, line_hint: "mock" }];
  }
  const system =
    "Find constants in the given sketch code that look like tunable " +
    "creative parameters (particle counts, speeds, color choices, sizes — " +
    "not canvas dimensions or setup boilerplate). Respond with ONLY a JSON " +
    'array, no prose, each item shaped exactly {"name": string, "kind": ' +
    '"number"|"string"|"boolean", "default": <value>, "line_hint": string}. ' +
    "Return [] if nothing looks tunable.";
  const text = await complete(env, system, code);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CopilotError("model did not return valid JSON", "provider_error");
  }
  if (!Array.isArray(parsed)) {
    throw new CopilotError("model response was not a JSON array", "provider_error");
  }
  return parsed as ParamGuess[];
}
