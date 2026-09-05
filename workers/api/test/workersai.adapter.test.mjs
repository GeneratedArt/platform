// Workers AI adapter: request building and response decoding.
//
// These are the parts where Workers AI's per-model inconsistency bites.
// The models genuinely disagree — flux-1-schnell takes `steps` and
// returns JSON base64, the Stable Diffusion family takes `num_steps` and
// returns a ReadableStream, and Leonardo's two models disagree with each
// other — so the catalogue's per-model shape is the thing under test.
//
// The previous single-path implementation accepted only a stream or a
// Uint8Array, which meant flux-1-schnell (the fastest, cheapest model in
// the catalogue) threw `unexpected Workers AI response shape` at render
// time, after the renderer had already been debited. The
// `json_base64_image` cases below are the regression guard for that.

import { build } from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const tmp = mkdtempSync(join(tmpdir(), "ga-waiadapter-"));
const outFile = join(tmp, "adapter.mjs");
const entry = join(tmp, "entry.ts");

writeFileSync(
  entry,
  `export { buildJsonInput, decodeOutput, filterParams, InferenceError } from ${JSON.stringify(join(srcDir, "ai", "inference"))};
export { getCatalogueEntry, isCatalogueModel, publishableModelIds, catalogueModelIds } from ${JSON.stringify(join(srcDir, "ai", "workersAiCatalogue"))};
`,
);

await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  // Bundle everything: the output lands in a temp dir outside the
  // project, so anything left external would not resolve at import time.
  outfile: outFile,
});

const {
  buildJsonInput,
  decodeOutput,
  filterParams,
  getCatalogueEntry,
  isCatalogueModel,
  publishableModelIds,
} = await import(pathToFileURL(outFile).href);

const FLUX = "@cf/black-forest-labs/flux-1-schnell";
const SDXL = "@cf/bytedance/stable-diffusion-xl-lightning";
const IMG2IMG = "@cf/runwayml/stable-diffusion-v1-5-img2img";
const INPAINT = "@cf/runwayml/stable-diffusion-v1-5-inpainting";
const LLAVA = "@cf/llava-hf/llava-1.5-7b-hf";
const QWEN = "@cf/qwen/qwen2.5-coder-32b-instruct";
const PHOENIX = "@cf/leonardo/phoenix-1.0";
const LUCID = "@cf/leonardo/lucid-origin";

const baseInput = (providerModelId, over = {}) => ({
  kind: "image",
  provider: "workers_ai",
  providerModelId,
  systemPrompt: null,
  prompt: "a cyberpunk lizard",
  params: null,
  seed: "12345",
  ...over,
});

// ---- response decoding ---------------------------------------------------

test("decodes json_base64_image — the shape that used to throw", async () => {
  const entryFlux = getCatalogueEntry(FLUX);
  assert.equal(entryFlux.responseShape, "json_base64_image");
  const original = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const b64 = Buffer.from(original).toString("base64");
  const { bytes, text } = await decodeOutput(entryFlux, { image: b64 });
  assert.equal(text, null);
  assert.deepEqual([...bytes], [...original]);
});

test("decodes a binary ReadableStream", async () => {
  const entrySd = getCatalogueEntry(SDXL);
  assert.equal(entrySd.responseShape, "binary");
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(payload);
      controller.close();
    },
  });
  const { bytes } = await decodeOutput(entrySd, stream);
  assert.deepEqual([...bytes], [...payload]);
});

test("decodes a bare Uint8Array on a binary model", async () => {
  const payload = new Uint8Array([9, 9, 9]);
  const { bytes } = await decodeOutput(getCatalogueEntry(SDXL), payload);
  assert.deepEqual([...bytes], [...payload]);
});

test("decodes json_text from the per-model field", async () => {
  // LLaVA answers in `description`; the instruct models use `response`.
  const llava = await decodeOutput(getCatalogueEntry(LLAVA), {
    description: "  a red square  ",
  });
  assert.equal(llava.text, "a red square");
  assert.equal(llava.bytes, null);

  const qwen = await decodeOutput(getCatalogueEntry(QWEN), {
    response: "expanded prompt",
  });
  assert.equal(qwen.text, "expanded prompt");
});

test("the two Leonardo models are decoded differently from each other", () => {
  assert.equal(getCatalogueEntry(PHOENIX).responseShape, "binary");
  assert.equal(getCatalogueEntry(LUCID).responseShape, "json_base64_image");
});

test("a mismatched response is rejected, not silently accepted", async () => {
  await assert.rejects(
    () => decodeOutput(getCatalogueEntry(FLUX), { nope: true }),
    /did not return a base64 image/,
  );
  await assert.rejects(
    () => decodeOutput(getCatalogueEntry(SDXL), { image: "abc" }),
    /did not return binary output/,
  );
  await assert.rejects(
    () => decodeOutput(getCatalogueEntry(QWEN), { response: "   " }),
    /did not return text/,
  );
});

// ---- request building ----------------------------------------------------

test("step parameter is named per model, not globally", () => {
  // Getting this wrong silently drops the caller's step count.
  const flux = buildJsonInput(getCatalogueEntry(FLUX), baseInput(FLUX));
  assert.equal(flux.steps, 4);
  assert.equal(flux.num_steps, undefined);

  const sd = buildJsonInput(getCatalogueEntry(SDXL), baseInput(SDXL));
  assert.equal(sd.num_steps, 4);
  assert.equal(sd.steps, undefined);
});

test("numeric seeds are forwarded, non-numeric ones are omitted", () => {
  const withSeed = buildJsonInput(getCatalogueEntry(FLUX), baseInput(FLUX));
  assert.equal(withSeed.seed, 12345);
  const hexSeed = buildJsonInput(
    getCatalogueEntry(FLUX),
    baseInput(FLUX, { seed: "0xdeadbeef" }),
  );
  assert.equal(hexSeed.seed, undefined);
});

test("img2img sends the source as a uint8 array", () => {
  const src = new Uint8Array([10, 20, 30]);
  const body = buildJsonInput(
    getCatalogueEntry(IMG2IMG),
    baseInput(IMG2IMG, { sourceImage: src }),
  );
  assert.deepEqual(body.image, [10, 20, 30]);
  assert.equal(body.mask, undefined);
});

test("inpainting sends both image and mask", () => {
  const body = buildJsonInput(
    getCatalogueEntry(INPAINT),
    baseInput(INPAINT, {
      sourceImage: new Uint8Array([1, 2]),
      maskImage: new Uint8Array([255, 0]),
    }),
  );
  assert.deepEqual(body.image, [1, 2]);
  assert.deepEqual(body.mask, [255, 0]);
});

test("edit lanes refuse to run without their binary inputs", () => {
  // Better to fail here than to be charged for a render that cannot work.
  assert.throws(
    () => buildJsonInput(getCatalogueEntry(IMG2IMG), baseInput(IMG2IMG)),
    /requires a source image/,
  );
  assert.throws(
    () =>
      buildJsonInput(
        getCatalogueEntry(INPAINT),
        baseInput(INPAINT, { sourceImage: new Uint8Array([1]) }),
      ),
    /requires a mask/,
  );
  assert.throws(
    () => buildJsonInput(getCatalogueEntry(LLAVA), baseInput(LLAVA)),
    /requires a source image/,
  );
});

test("instruct models get a chat transcript, with the system prompt when set", () => {
  const body = buildJsonInput(
    getCatalogueEntry(QWEN),
    baseInput(QWEN, { systemPrompt: "you expand prompts" }),
  );
  assert.deepEqual(body.messages, [
    { role: "system", content: "you expand prompts" },
    { role: "user", content: "a cyberpunk lizard" },
  ]);
  assert.equal(body.prompt, undefined);

  const noSystem = buildJsonInput(getCatalogueEntry(QWEN), baseInput(QWEN));
  assert.equal(noSystem.messages.length, 1);
  assert.equal(noSystem.messages[0].role, "user");
});

// ---- params + allowlist --------------------------------------------------

test("caller params override defaults but unknown keys are dropped", () => {
  const params = filterParams(getCatalogueEntry(SDXL), {
    num_steps: 12,
    guidance: 9,
    // Not on SDXL's allowlist — some models reject unknown keys and
    // others ignore them, so neither is forwarded.
    definitely_not_a_param: "x",
    steps: 99,
  });
  assert.equal(params.num_steps, 12);
  assert.equal(params.guidance, 9);
  assert.equal(params.definitely_not_a_param, undefined);
  assert.equal(params.steps, undefined);
});

test("catalogue membership gates registration", () => {
  assert.ok(isCatalogueModel(FLUX));
  assert.ok(!isCatalogueModel("@cf/black-forest-labs/flux-1-schnel")); // typo
  assert.ok(!isCatalogueModel("../../etc/passwd"));
  assert.ok(!isCatalogueModel(""));
});

test("companion text models are not offered as publishable", () => {
  const publishable = publishableModelIds();
  assert.ok(publishable.includes(FLUX));
  assert.ok(!publishable.includes(LLAVA));
  assert.ok(!publishable.includes(QWEN));
});
