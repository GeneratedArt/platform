---
name: Cloudflare production setup
description: Durable constraints for the GeneratedArt Cloudflare Pages, DNS, Worker, and D1 deployment.
---

Cloudflare Pages and the existing generatedart-api Worker can be reached through the generatedart.com zone, but the production D1 database has a legacy schema and migration ledger that differs from the current repository migrations. Do not force the current migration sequence or deploy newer Worker code until the schema is reconciled safely.

**Why:** Wrangler stopped on a duplicate `license` column before applying the remaining migrations, demonstrating that the production database is not a clean instance of the repository's migration history.

**How to apply:** Treat D1 reconciliation as a prerequisite for future API deployments. Preserve existing data, use additive migrations or a verified replacement strategy, and verify the Worker endpoints after deployment.

Cloudflare Workers/Pages Builds currently use Ruby 3.4, where Jekyll's `csv` dependency must be declared explicitly rather than assumed to be available from the standard library. Keep the repository's build hook self-diagnosing and run `bundle install` before `bundle exec jekyll build`.

**Why:** The Cloudflare build failed during Jekyll startup with `cannot load such file -- csv`, while the same repository worked under the local Ruby toolchain.

**How to apply:** Keep `csv` in the root Gemfile/lockfile and use `scripts/cf-build.sh` for Cloudflare's custom build command so Ruby, Bundler, dependency, and generated-site failures are visible in build output.