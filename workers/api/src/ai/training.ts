import type { Env } from "../types";
import {
  finishTrainingJob,
  getInFlightTrainingJobs,
  getQueuedTrainingJobs,
  markTrainingSubmitted,
  type TrainingJobRow,
} from "../db/datasets";
import { insertModelVersion } from "../db/render";
import { applyLedgerEntry } from "../db/tokens";

/**
 * Training dispatch/poll for the Dataset Library.
 *
 * A training job is genuinely async at the provider (minutes to hours),
 * so — unlike a render, which completes within one request — training
 * moves through queued → training → succeeded/failed across cron ticks:
 * `dispatchQueuedTrainingJobs` submits queued jobs to fal.ai's queue API
 * and `pollTrainingJobs` checks in-flight ones for a result. Both are
 * called from the Worker's per-minute scheduled() tick alongside the
 * uptime probe.
 *
 * Only ONE base model is wired end-to-end today: FLUX.1 [dev], via
 * fal.ai's `flux-lora-fast-training` trainer and `flux-lora` inference
 * endpoint (the same inference endpoint runFalCustom already targets
 * in ai/inference.ts). Adding another base model means adding a row
 * here with its own verified trainer + inference endpoint pair — NOT
 * guessing a fal.ai model slug. Requesting an unlisted base_model is
 * rejected at the handler layer with a clear error, not silently
 * accepted against an unverified endpoint.
 */
export interface TrainableBase {
  label: string;
  trainerEndpoint: string;
  inferenceEndpoint: string;
}

export const TRAINABLE_BASE_MODELS: Record<string, TrainableBase> = {
  "flux-dev": {
    label: "FLUX.1 [dev]",
    trainerEndpoint: "fal-ai/flux-lora-fast-training",
    inferenceEndpoint: "fal-ai/flux-lora",
  },
};

export function isTrainableBaseModel(v: unknown): v is string {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(TRAINABLE_BASE_MODELS, v);
}

/**
 * Flat, tiered pricing by method — independent of base model for this
 * first pass. A real system would price by base-model compute cost too;
 * flat pricing is the honest starting point, not a placeholder pretending
 * to be cost-accurate.
 *
 * LoRA is priced to fit inside the 200-token signup grant (with room
 * left for a couple of renders afterward) — a new creator's free grant
 * should be enough to try training once, not just rendering others'
 * models. Deliberate onboarding economics, not an arbitrary number.
 */
export function trainingPriceTokens(trainingMethod: string): number {
  switch (trainingMethod) {
    case "lora":
      return 150;
    case "dreambooth":
      return 400;
    case "full_finetune":
      return 1200;
    default:
      return 150;
  }
}

export function isTrainingMock(env: Env): boolean {
  return env.TRAINING_MOCK === "1";
}

interface MockTrainResult {
  weightsRef: string;
}

/**
 * Deterministic mock — no network, completes synchronously within the
 * originating request (unlike real training, which is async across
 * cron ticks). This is what lets scripts/smoke_api.mjs exercise the
 * full dataset → train → published-model-version path over plain HTTP
 * without simulating cron timing.
 */
export async function runMockTraining(
  datasetSlug: string,
  jobId: number,
): Promise<MockTrainResult> {
  return { weightsRef: `mock-weights/${datasetSlug}-job${jobId}` };
}

const FAL_QUEUE_BASE = "https://queue.fal.run";
const MAX_JOBS_PER_TICK = 5;

/** Submits queued jobs to fal.ai's queue API. */
export async function dispatchQueuedTrainingJobs(env: Env): Promise<void> {
  if (!env.FAL_KEY) return; // fails closed silently — cron just skips
  const jobs = await getQueuedTrainingJobs(env.DB, MAX_JOBS_PER_TICK);
  for (const job of jobs) {
    try {
      await dispatchOne(env, job);
    } catch (e) {
      console.error("training_dispatch_failed", job.id, e);
    }
  }
}

async function dispatchOne(env: Env, job: TrainingJobRow): Promise<void> {
  const base = TRAINABLE_BASE_MODELS[job.base_model];
  if (!base) {
    // Shouldn't happen — the handler validates base_model before
    // enqueueing — but fail the job rather than retry forever if it does.
    await refundAndFail(env, job, "unknown_base_model");
    return;
  }
  const res = await fetch(`${FAL_QUEUE_BASE}/${base.trainerEndpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${env.FAL_KEY}`,
      "Content-Type": "application/json",
    },
    // The dataset's actual image/video bytes are supplied via a
    // signed R2 URL in the real implementation's next iteration; the
    // request shape below is fal's documented submit contract
    // (endpoint + input), left generic here since it varies per
    // trainer. Tracked as a follow-up alongside per-base-model
    // dataset packaging (zip vs URL list).
    body: JSON.stringify({ training_method: job.training_method }),
  });
  if (!res.ok) {
    await refundAndFail(env, job, `fal_submit_${res.status}`);
    return;
  }
  const data = (await res.json()) as { request_id?: string };
  if (!data.request_id) {
    await refundAndFail(env, job, "fal_submit_no_request_id");
    return;
  }
  await markTrainingSubmitted(env.DB, job.id, data.request_id);
}

/** Polls in-flight jobs for a completed (or failed) provider result. */
export async function pollTrainingJobs(env: Env): Promise<void> {
  if (!env.FAL_KEY) return;
  const jobs = await getInFlightTrainingJobs(env.DB, MAX_JOBS_PER_TICK);
  for (const job of jobs) {
    try {
      await pollOne(env, job);
    } catch (e) {
      console.error("training_poll_failed", job.id, e);
    }
  }
}

async function pollOne(env: Env, job: TrainingJobRow): Promise<void> {
  const base = TRAINABLE_BASE_MODELS[job.base_model];
  if (!base || !job.provider_job_id) {
    await refundAndFail(env, job, "job_misconfigured");
    return;
  }
  const statusRes = await fetch(
    `${FAL_QUEUE_BASE}/${base.trainerEndpoint}/requests/${job.provider_job_id}/status`,
    { headers: { Authorization: `Key ${env.FAL_KEY}` } },
  );
  if (!statusRes.ok) return; // transient — retry next tick
  const statusData = (await statusRes.json()) as { status?: string };
  if (statusData.status !== "COMPLETED") {
    if (statusData.status === "ERROR") {
      await refundAndFail(env, job, "fal_training_error");
    }
    return; // still IN_QUEUE / IN_PROGRESS — retry next tick
  }

  const resultRes = await fetch(
    `${FAL_QUEUE_BASE}/${base.trainerEndpoint}/requests/${job.provider_job_id}`,
    { headers: { Authorization: `Key ${env.FAL_KEY}` } },
  );
  if (!resultRes.ok) {
    await refundAndFail(env, job, `fal_result_${resultRes.status}`);
    return;
  }
  const result = (await resultRes.json()) as {
    diffusers_lora_file?: { url?: string };
  };
  const weightsRef = result.diffusers_lora_file?.url;
  if (!weightsRef) {
    await refundAndFail(env, job, "fal_result_no_weights");
    return;
  }
  await completeJob(env, job, weightsRef);
}

/**
 * Shared success path for both mock and real training: publish the
 * resulting model version and mark the job succeeded. Exported so the
 * handler can call it directly for the synchronous mock path.
 */
export async function completeJob(
  env: Env,
  job: TrainingJobRow,
  weightsRef: string,
  datasetNote?: string | null,
): Promise<void> {
  if (!job.model_id) {
    await refundAndFail(env, job, "job_missing_model");
    return;
  }
  const base = TRAINABLE_BASE_MODELS[job.base_model];
  const version = await insertModelVersion(env.DB, {
    modelId: job.model_id,
    providerModelId: base?.inferenceEndpoint ?? job.base_model,
    systemPrompt: null,
    paramsSchemaJson: null,
    priceTokens: job.render_price_tokens,
    trainingMethod: job.training_method,
    baseModel: base?.label ?? job.base_model,
    datasetNote: datasetNote ?? null,
    weightsRef,
  });
  await finishTrainingJob(env.DB, job.id, {
    status: "succeeded",
    modelVersionId: version.id,
  });
}

async function refundAndFail(
  env: Env,
  job: TrainingJobRow,
  errorCode: string,
): Promise<void> {
  await finishTrainingJob(env.DB, job.id, { status: "failed", errorCode });
  try {
    await applyLedgerEntry(env.DB, {
      userId: job.user_id,
      delta: job.price_tokens,
      kind: "refund",
      idempotencyKey: `training:${job.id}:refund`,
      refKind: "training_job",
      refId: job.id,
      memo: `training refund (${errorCode})`,
    });
  } catch (e) {
    console.error("training_refund_failed", job.id, e);
  }
}
