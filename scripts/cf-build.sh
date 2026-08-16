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

if ! ruby -e 'require "csv"; puts "csv=#{CSV::VERSION}"'; then
  echo "cf-build: csv is unavailable; run bundle install with the committed Gemfile.lock" >&2
  exit 1
fi

bundle check || bundle install --jobs 4 --retry 3
bundle exec jekyll build

test -f "_site/index.html"
echo "cf-build: Jekyll build succeeded; generated _site/index.html"