import type { Context } from "hono";
import type { Env } from "../types";
import type { AuthVariables } from "../auth/middleware";
import { getAuthUser } from "../auth/middleware";
import { getProjectById } from "../db/projects";
import { checkRateLimit } from "../lib/rateLimit";
import { applyLedgerEntry } from "../db/tokens";
import {
  generateSketch,
  editSketch,
  explainSketch,
  extractParams,
  CopilotError,
} from "../ai/copilot";

/**
 * Studio Copilot routes. Owner-only — the copilot edits/generates
 * code for a project the caller owns, unlike the render-model
 * marketplace which is open to any renderer. See ai/copilot.ts for
 * why this is a separate surface from the model registry.
 *
 * Every call debits the render-token ledger before the Anthropic
 * request and refunds in full on failure — the same discipline as
 * render_jobs, without a persisted job row: these are ephemeral
 * editor assists, not published, re-runnable renders someone would
 * browse later.
 */

const PRICE_TOKENS: Record<"generate" | "edit" | "explain" | "params", number> = {
  generate: 20,
  edit: 15,
  explain: 5,
  params: 5,
};

const PROMPT_MAX = 2000;
const CODE_MAX = 100_000;
const INSTRUCTION_MAX = 1000;

function badRequest(c: Context, error: string, detail?: unknown) {
  return c.json({ error, detail }, 400);
}

async function loadOwnedProject(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const id = parseInt(c.req.param("id") || "", 10);
  if (!id || Number.isNaN(id)) return { error: badRequest(c, "invalid_id") };
  const project = await getProjectById(c.env.DB, id);
  if (!project) return { error: c.json({ error: "not_found" }, 404) };
  const session = getAuthUser(c);
  if (project.owner_id !== session.uid) {
    return { error: c.json({ error: "forbidden" }, 403) };
  }
  return { project, session };
}

/**
 * Debit → call Claude → settle. Shared by all four routes so the
 * debit/refund discipline can't drift between them.
 */
async function withDebit<T>(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
  action: keyof typeof PRICE_TOKENS,
  session: { uid: number },
  run: () => Promise<T>,
): Promise<Response> {
  const price = PRICE_TOKENS[action];
  const idempotencyKey = `copilot:${action}:${session.uid}:${crypto.randomUUID()}`;
  const debit = await applyLedgerEntry(c.env.DB, {
    userId: session.uid,
    delta: -price,
    kind: "debit",
    idempotencyKey,
    refKind: "copilot",
    refId: null,
    memo: `copilot: ${action}`,
  });
  if (debit.status === "insufficient") {
    return c.json(
      { error: "insufficient_balance", balance: debit.balance, shortfall: debit.shortfall },
      402,
    );
  }
  try {
    const result = await run();
    return c.json({ result, price_tokens: price }, 200);
  } catch (e) {
    try {
      await applyLedgerEntry(c.env.DB, {
        userId: session.uid,
        delta: price,
        kind: "refund",
        idempotencyKey: `${idempotencyKey}:refund`,
        refKind: "copilot",
        refId: null,
        memo: `copilot refund: ${action}`,
      });
    } catch (refundErr) {
      console.error("copilot_refund_failed", refundErr);
    }
    const code = e instanceof CopilotError ? e.code : "copilot_failed";
    return c.json({ error: code }, code === "provider_unconfigured" ? 503 : 502);
  }
}

interface GenerateBody {
  prompt?: unknown;
}

/** POST /v1/projects/:id/ai/generate */
export async function aiGenerateHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const loaded = await loadOwnedProject(c);
  if (loaded.error) return loaded.error;
  const { project, session } = loaded;

  const rl = await checkRateLimit(c.env.RATE_LIMIT, {
    key: `ai:generate:${session!.uid}`,
    limit: 30,
    windowSeconds: 3600,
  });
  if (!rl.ok) return c.json({ error: "rate_limited", reset_at: rl.resetAt }, 429);

  let body: GenerateBody;
  try {
    body = await c.req.json<GenerateBody>();
  } catch {
    return badRequest(c, "invalid_json");
  }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt || prompt.length > PROMPT_MAX) return badRequest(c, "invalid_prompt", { max: PROMPT_MAX });

  return withDebit(c, "generate", session!, () =>
    generateSketch(c.env, { engine: project!.engine, prompt }),
  );
}

interface EditBody {
  current_code?: unknown;
  instruction?: unknown;
}

/** POST /v1/projects/:id/ai/edit */
export async function aiEditHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const loaded = await loadOwnedProject(c);
  if (loaded.error) return loaded.error;
  const { project, session } = loaded;

  const rl = await checkRateLimit(c.env.RATE_LIMIT, {
    key: `ai:edit:${session!.uid}`,
    limit: 30,
    windowSeconds: 3600,
  });
  if (!rl.ok) return c.json({ error: "rate_limited", reset_at: rl.resetAt }, 429);

  let body: EditBody;
  try {
    body = await c.req.json<EditBody>();
  } catch {
    return badRequest(c, "invalid_json");
  }
  const currentCode = typeof body.current_code === "string" ? body.current_code : "";
  if (!currentCode || currentCode.length > CODE_MAX) return badRequest(c, "invalid_current_code", { max: CODE_MAX });
  const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
  if (!instruction || instruction.length > INSTRUCTION_MAX) {
    return badRequest(c, "invalid_instruction", { max: INSTRUCTION_MAX });
  }

  return withDebit(c, "edit", session!, () =>
    editSketch(c.env, { engine: project!.engine, currentCode, instruction }),
  );
}

interface CodeBody {
  code?: unknown;
}

function readCode(body: CodeBody): string | null {
  const code = typeof body.code === "string" ? body.code : "";
  if (!code || code.length > CODE_MAX) return null;
  return code;
}

/** POST /v1/projects/:id/ai/explain */
export async function aiExplainHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const loaded = await loadOwnedProject(c);
  if (loaded.error) return loaded.error;
  const { session } = loaded;

  const rl = await checkRateLimit(c.env.RATE_LIMIT, {
    key: `ai:explain:${session!.uid}`,
    limit: 60,
    windowSeconds: 3600,
  });
  if (!rl.ok) return c.json({ error: "rate_limited", reset_at: rl.resetAt }, 429);

  let body: CodeBody;
  try {
    body = await c.req.json<CodeBody>();
  } catch {
    return badRequest(c, "invalid_json");
  }
  const code = readCode(body);
  if (code === null) return badRequest(c, "invalid_code", { max: CODE_MAX });

  return withDebit(c, "explain", session!, () => explainSketch(c.env, code));
}

/** POST /v1/projects/:id/ai/params */
export async function aiParamsHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const loaded = await loadOwnedProject(c);
  if (loaded.error) return loaded.error;
  const { session } = loaded;

  const rl = await checkRateLimit(c.env.RATE_LIMIT, {
    key: `ai:params:${session!.uid}`,
    limit: 60,
    windowSeconds: 3600,
  });
  if (!rl.ok) return c.json({ error: "rate_limited", reset_at: rl.resetAt }, 429);

  let body: CodeBody;
  try {
    body = await c.req.json<CodeBody>();
  } catch {
    return badRequest(c, "invalid_json");
  }
  const code = readCode(body);
  if (code === null) return badRequest(c, "invalid_code", { max: CODE_MAX });

  return withDebit(c, "params", session!, () => extractParams(c.env, code));
}
