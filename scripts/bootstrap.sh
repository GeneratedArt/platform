#!/usr/bin/env bash
# GeneratedArt local bootstrap. Idempotent. Target: <10 minutes on a fresh clone.
set -euo pipefail

echo "==> GeneratedArt bootstrap"

# 1. Ruby gems for the Jekyll site
if [ -d site ]; then
  if command -v bundle >/dev/null 2>&1; then
    echo "==> Installing Ruby gems (site/)"
    ( cd site && bundle install )
  else
    echo "!! Skipping Jekyll setup: 'bundle' not found."
    echo "!! Install Ruby 3.2+ and run: gem install bundler"
  fi
fi

# 2. Node deps via pnpm
if command -v pnpm >/dev/null 2>&1; then
  echo "==> Installing Node deps (pnpm)"
  pnpm install
else
  echo "!! pnpm not found. Install via: npm i -g pnpm@9"
fi

# 3. Foundry
if [ -d contracts ]; then
  if ! command -v forge >/dev/null 2>&1; then
    echo "==> Installing Foundry"
    curl -fsSL https://foundry.paradigm.xyz | bash
    export PATH="$HOME/.foundry/bin:$PATH"
    foundryup
  fi
  echo "==> Installing Foundry libraries"
  ( cd contracts && \
    forge install foundry-rs/forge-std --no-commit 2>/dev/null || true && \
    forge install OpenZeppelin/openzeppelin-contracts --no-commit 2>/dev/null || true && \
    forge install chiru-labs/ERC721A --no-commit 2>/dev/null || true )
fi

# 4. Local D1: create + apply migrations + seed
if command -v pnpm >/dev/null 2>&1 && [ -d workers/api ]; then
  echo "==> Applying D1 migrations (local)"
  ( cd workers/api && pnpm exec wrangler d1 migrations apply generatedart --local || true )
  if [ -f scripts/seed.sql ]; then
    echo "==> Seeding local D1"
    ( cd workers/api && pnpm exec wrangler d1 execute generatedart --local --file=../../scripts/seed.sql || true )
  fi
fi

# 5. .dev.vars from example
if [ -f workers/api/.dev.vars.example ] && [ ! -f workers/api/.dev.vars ]; then
  cp workers/api/.dev.vars.example workers/api/.dev.vars
  echo "==> Created workers/api/.dev.vars from example. Fill in real secrets."
fi

# 6. git-secrets
if command -v git-secrets >/dev/null 2>&1; then
  git secrets --install -f >/dev/null 2>&1 || true
  git secrets --register-aws >/dev/null 2>&1 || true
fi

echo
echo "==> Done. Next: pnpm dev"
