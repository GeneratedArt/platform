#!/usr/bin/env bash
# Re-fetch the pinned p5/three runtimes the freeze bundler inlines.
# See vendor/README.md for why these are committed rather than CDN-loaded.
set -euo pipefail

P5_VERSION="1.9.4"
THREE_VERSION="0.160.1"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
vendor="$here/vendor"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$vendor"
cd "$tmp"

echo "→ fetching p5@$P5_VERSION and three@$THREE_VERSION from npm"
npm pack "p5@$P5_VERSION" "three@$THREE_VERSION" --silent >/dev/null

tar xzf "p5-$P5_VERSION.tgz" package/lib/p5.min.js -O > "$vendor/p5.min.js"
tar xzf "three-$THREE_VERSION.tgz" package/build/three.min.js -O > "$vendor/three.min.js"

# A truncated or HTML-error-page download would still "succeed" above and
# then produce a valid-but-broken frozen bundle, so sanity-check the sizes.
for f in p5.min.js three.min.js; do
  size=$(wc -c < "$vendor/$f")
  if [ "$size" -lt 100000 ]; then
    echo "✗ $f is only ${size}B — refusing to write a truncated runtime" >&2
    exit 1
  fi
  echo "✓ vendor/$f (${size}B)"
done
