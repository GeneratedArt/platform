import type { Context } from "hono";
import type { Env } from "../types";
import type { AuthVariables } from "../auth/middleware";
import { getAuthUser } from "../auth/middleware";
import { checkRateLimit } from "../lib/rateLimit";
import {
  INDUSTRIES,
  type Industry,
  insertBrief,
  getBriefById,
  getBriefAuthor,
  listBriefs,
  type BriefListItem,
  type BriefRow,
  type BriefAuthor,
} from "../db/briefs";

const TITLE_MAX = 200;
const BODY_MAX = 10_000;
const BUDGET_RE = /^\d+(?:\.\d{1,18})?$/; // ETH amount string
const LIST_DEFAULT = 20;
const LIST_MAX = 50;
// 100 years from now — anything past this is almost certainly a millisecond
// timestamp the client forgot to /1000.
const DEADLINE_MAX = Math.floor(Date.now() / 1000) + 100 * 365 * 86400;

interface CreateBody {
  industry?: unknown;
  title?: unknown;
  body?: unknown;
  budget?: unknown;
  deadline?: unknown;
}

function badRequest(c: Context, error: string, detail?: unknown) {
  return c.json({ error, detail }, 400);
}

function isIndustry(v: unknown): v is Industry {
  return typeof v === "string" && (INDUSTRIES as readonly string[]).includes(v);
}

function publicBrief(b: BriefRow, author: BriefAuthor) {
  return {
    id: b.id,
    industry: b.industry,
    title: b.title,
    body: b.body,
    budget: b.budget,
    deadline: b.deadline,
    status: b.status,
    created_at: b.created_at,
    updated_at: b.updated_at,
    author: {
      id: author.id,
      handle: author.handle,
      display_name: author.display_name,
      avatar_url: author.avatar_url,
    },
  };
}

function publicBriefListItem(b: BriefListItem) {
  return {
    id: b.id,
    industry: b.industry,
    title: b.title,
    // Trim the body to a snippet for the listing — full markdown is fetched
    // from the detail endpoint. We strip newlines so the snippet renders
    // as one line in the card.
    body_snippet: b.body.replace(/\s+/g, " ").trim().slice(0, 240),
    budget: b.budget,
    deadline: b.deadline,
    status: b.status,
    created_at: b.created_at,
    author: {
      id: b.author_id,
      handle: b.author_handle,
      display_name: b.author_display_name,
      avatar_url: b.author_avatar_url,
    },
  };
}

// GET /v1/briefs?industry=…&limit=&before=
// Public — anyone can browse. Defaults to status='open'.
export async function listBriefsHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const url = new URL(c.req.url);
  const industryRaw = url.searchParams.get("industry");
  let industry: Industry | undefined;
  if (industryRaw) {
    if (!isIndustry(industryRaw)) {
      return badRequest(c, "invalid_industry", { allowed: INDUSTRIES });
    }
    industry = industryRaw;
  }

  const limitRaw = url.searchParams.get("limit");
  let limit = LIST_DEFAULT;
  if (limitRaw) {
    const n = parseInt(limitRaw, 10);
    if (!Number.isFinite(n) || n < 1 || n > LIST_MAX) {
      return badRequest(c, "invalid_limit", { max: LIST_MAX });
    }
    limit = n;
  }

  const beforeRaw = url.searchParams.get("before");
  let before: number | undefined;
  if (beforeRaw) {
    const n = parseInt(beforeRaw, 10);
    if (!Number.isFinite(n) || n < 0) {
      return badRequest(c, "invalid_before");
    }
    before = n;
  }

  const rows = await listBriefs(c.env.DB, { industry, limit, before });
  return c.json({
    briefs: rows.map(publicBriefListItem),
    next_before: rows.length === limit ? rows[rows.length - 1].created_at : null,
  });
}

// GET /v1/briefs/:id
export async function getBriefHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const id = parseInt(c.req.param("id") ?? "", 10);
  if (!Number.isFinite(id) || id < 1) return badRequest(c, "invalid_id");
  const brief = await getBriefById(c.env.DB, id);
  if (!brief) return c.json({ error: "not_found" }, 404);
  const author = await getBriefAuthor(c.env.DB, brief.author_id);
  if (!author) return c.json({ error: "author_missing" }, 500);
  return c.json({ brief: publicBrief(brief, author) });
}

// POST /v1/briefs — auth required, 5/address/day rate limit.
export async function createBriefHandler(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
) {
  const session = getAuthUser(c);

  const rl = await checkRateLimit(c.env.RATE_LIMIT, {
    key: `briefs:create:${session.sub}`,
    limit: 5,
    windowSeconds: 86400,
  });
  if (!rl.ok) {
    return c.json({ error: "rate_limited", reset_at: rl.resetAt }, 429);
  }

  let body: CreateBody;
  try {
    body = await c.req.json<CreateBody>();
  } catch {
    return badRequest(c, "invalid_json");
  }

  if (!isIndustry(body.industry)) {
    return badRequest(c, "invalid_industry", { allowed: INDUSTRIES });
  }
  const industry = body.industry;

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title || title.length > TITLE_MAX) {
    return badRequest(c, "invalid_title", { max: TITLE_MAX });
  }

  const briefBody = typeof body.body === "string" ? body.body.trim() : "";
  if (!briefBody || briefBody.length > BODY_MAX) {
    return badRequest(c, "invalid_body", { max: BODY_MAX });
  }

  let budget: string | null = null;
  if (body.budget !== undefined && body.budget !== null && body.budget !== "") {
    if (typeof body.budget !== "string" || !BUDGET_RE.test(body.budget)) {
      return badRequest(c, "invalid_budget");
    }
    budget = body.budget;
  }

  let deadline: number | null = null;
  if (body.deadline !== undefined && body.deadline !== null && body.deadline !== "") {
    const n = typeof body.deadline === "number"
      ? body.deadline
      : typeof body.deadline === "string"
        ? parseInt(body.deadline, 10)
        : NaN;
    if (!Number.isFinite(n) || n < 0 || n > DEADLINE_MAX) {
      return badRequest(c, "invalid_deadline");
    }
    deadline = n;
  }

  const row = await insertBrief(c.env.DB, {
    authorId: session.uid,
    title,
    body: briefBody,
    industry,
    budget,
    deadline,
  });
  const author = await getBriefAuthor(c.env.DB, session.uid);
  if (!author) return c.json({ error: "author_missing" }, 500);
  return c.json({ brief: publicBrief(row, author) }, 201);
}
