-- Adds the `fal_custom` provider lane: creator-trained custom art models
-- (a fine-tuned checkpoint or LoRA on a diffusion base, in the vein of
-- Refik Anadol's bespoke, dataset-trained visual signatures) as distinct
-- from prompting a fixed catalogue model.
--
-- Why not Workers AI for this: its LoRA fine-tuning (open beta) only
-- accepts text model_types (mistral/gemma/llama) — no image/diffusion
-- LoRA support as of this writing. A creative coder's own trained
-- checkpoint has to run somewhere that hosts custom weights on demand;
-- fal.ai's private-model inference fits the platform's no-idle-GPU
-- budget stance (pay-per-run, no fixed hosting cost) better than
-- self-hosting a GPU or Replicate's cold-start-billed custom deploys.
--
-- These columns describe training lineage, not runtime params, so they
-- live on the immutable per-version row alongside provider_model_id —
-- a creator retraining on a new dataset publishes a new version rather
-- than rewriting one that jobs already reference.

ALTER TABLE render_model_versions ADD COLUMN training_method TEXT;
ALTER TABLE render_model_versions ADD COLUMN base_model       TEXT;
-- Creator's own description of what the model was trained on. This is
-- the platform's provenance/disclosure surface for a custom model —
-- public alongside the version, unlike weights_ref and system_prompt.
ALTER TABLE render_model_versions ADD COLUMN dataset_note     TEXT;
-- Pointer to the trained weights at the provider (e.g. a fal.ai model
-- id or LoRA URL). Required when provider = 'fal_custom'. Treated with
-- the same owner-only visibility as system_prompt — it's how another
-- creator could clone the model's exact output.
ALTER TABLE render_model_versions ADD COLUMN weights_ref      TEXT;
