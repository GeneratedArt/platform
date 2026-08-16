---
name: Cloudflare production setup
description: Durable constraints for the GeneratedArt Cloudflare Pages, DNS, Worker, and D1 deployment.
---

Cloudflare Pages and the existing generatedart-api Worker can be reached through the generatedart.com zone, but the production D1 database has a legacy schema and migration ledger that differs from the current repository migrations. Do not force the current migration sequence or deploy newer Worker code until the schema is reconciled safely.

**Why:** Wrangler stopped on a duplicate `license` column before applying the remaining migrations, demonstrating that the production database is not a clean instance of the repository's migration history.

**How to apply:** Treat D1 reconciliation as a prerequisite for future API deployments. Preserve existing data, use additive migrations or a verified replacement strategy, and verify the Worker endpoints after deployment.