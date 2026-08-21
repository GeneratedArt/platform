// Client-side mirror of TRAINABLE_BASE_MODELS in src/ai/training.ts.
// Duplicated rather than imported because client/ bundles separately
// from src/ (different esbuild entry points, no shared runtime) — this
// is presentation-only (label text for the base-model picker); the
// SERVER remains the source of truth and re-validates every value on
// POST /v1/datasets/:slug/train regardless of what this list offers.
// Keep in sync by hand when a new base model is verified end-to-end.
export interface TrainableBase {
  label: string;
}

export const TRAINABLE_BASE_MODELS: Record<string, TrainableBase> = {
  "flux-dev": { label: "FLUX.1 [dev]" },
};
