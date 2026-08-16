#!/usr/bin/env bash
set -Eeuo pipefail

# Cloudflare Workers Builds invokes this script from the repository root.
# Keep diagnostics here because Cloudflare's build UI can omit the useful
# portion of a failed custom-build traceback.

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

on_error() {
  local exit_code=$?
  echo "cf-build: failed at line ${BASH_LINENO[0]} with exit code ${exit_code}" >&2
  echo "cf-build: pwd=$(pwd)" >&2
  echo "cf-build: ruby=$(command -v ruby || echo missing)" >&2
  echo "cf-build: bundle=$(command -v bundle || echo missing)" >&2
  exit "$exit_code"
}
trap on_error ERR

echo "cf-build: starting in $ROOT_DIR"
echo "cf-build: ruby=$(ruby --version)"
echo "cf-build: bundler=$(bundle --version)"

bundle check || bundle install --jobs 4 --retry 3
if ! bundle exec ruby -e 'require "csv"; require "base64"; puts "csv=#{CSV::VERSION} base64=available"'; then
  echo "cf-build: required Ruby default gems are unavailable from the bundle" >&2
  exit 1
fi

export JEKYLL_ENV="${JEKYLL_ENV:-production}"
bundle exec jekyll build

test -f "_site/index.html"
echo "cf-build: Jekyll build succeeded; generated _site/index.html"