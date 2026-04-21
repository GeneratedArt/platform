---
layout: genart
title: "Manifesto"
description: "What GeneratedArt stands for."
permalink: /manifesto/
---

<article class="ga-article">
  <h1>Manifesto</h1>

  <p><em>What follows is the community charter of GeneratedArt — the set of
  commitments every artist, collector, curator, and steward agrees to when
  they take part. We update it in the open, on GitHub, with every change
  signed off by the curator team.</em></p>

  <h2>1. The artwork is the code.</h2>
  <p>A generative work is not the rendered image — it is the program that
  produces it from a hash. We mint the program, archive the program, and we
  consider the program the canonical artwork. Renders are merely one
  consequence of running it.</p>

  <h2>2. Determinism is not optional.</h2>
  <p>Every project ships through a validator that runs it twice with the same
  hash and rejects the merge if a single pixel differs. If your work needs
  randomness, seed it from the on-chain hash. Never <code>Math.random()</code>.</p>

  <h2>3. Open source by default.</h2>
  <p>Every project lives in a public repository under the
  <code>GeneratedArt</code> GitHub organisation. Licenses are the artist's
  choice, but the source must be readable, forkable, and pinned to IPFS.</p>

  <h2>4. The chain is the registry, not the renderer.</h2>
  <p>Tokens are ERC-721. The on-chain record is small: hash, bundle CID,
  metadata CID, royalty splits. Rendering happens client-side from that record,
  so the work survives the disappearance of any one server, including ours.</p>

  <h2>5. Royalties are enforced where they can be.</h2>
  <p>Primary sales settle to a 70 / 25 / 5 split between artist, gallery, and
  platform commons. Secondary royalties are set per project via EIP-2981, paid
  through an on-chain splitter contract — no off-chain bookkeeping.</p>

  <h2>6. Curation is human.</h2>
  <p>Artist applications and project releases are reviewed by a rotating
  curator group. We use GitHub issues and pull requests as the audit trail —
  no private Discord channels, no DMs.</p>

  <h2>7. The physical world matters.</h2>
  <p>Our Geneva gallery is the working bridge between the chain and the
  street. Selected drops are exhibited in person and shipped as ePaper
  dongles. Holding the digital token entitles the collector to claim the
  physical artefact.</p>

  <h2>8. We answer to the holders.</h2>
  <p>Steward keys are multi-sig. Treasury is public. Governance proposals
  ship as pull requests. If the platform goes off course, the holders take
  the contracts, the bundles, and the gallery archive — all of it survives
  without us.</p>

  <hr />
  <p style="color:var(--fg-subtle);font-family:var(--mono);font-size:0.8rem">
    v1.0 — Geneva, April 2026 · <a href="https://github.com/GeneratedArt/website/blob/main/site/manifesto.md" rel="noopener">edit on GitHub</a>
  </p>
</article>
