#!/usr/bin/env bash
# Grant curator status to a user by handle. Idempotent — running twice
# is a no-op. Until self-serve verification ships (follow-up task #42),
# this is the operational way to flip `users.is_curator = 1` so a
# verified curator can use /galleries/new.
#
# Usage:
#   ./scripts/grant_curator.sh <handle>                 # local D1
#   ./scripts/grant_curator.sh <handle> --remote        # production D1
#   ./scripts/grant_curator.sh <handle> --revoke        # set to 0 again
#
# The script runs from anywhere — it cd's into workers/api so the
# wrangler.toml [[d1_databases]] block is picked up.

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <handle> [--remote] [--revoke]" >&2
  exit 1
fi

HANDLE="$1"
shift || true
TARGET="--local"
VALUE=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --remote) TARGET="--remote" ;;
    --local)  TARGET="--local"  ;;
    --revoke) VALUE=0 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
  shift
done

# Ensure we're in workers/api regardless of caller's cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# Lowercase the handle to match the column's normalisation.
LC_HANDLE="$(printf '%s' "$HANDLE" | tr '[:upper:]' '[:lower:]')"

echo "Setting is_curator=${VALUE} for handle='${LC_HANDLE}' on ${TARGET}…"

# Single-statement SQL keeps the wrangler call simple and idempotent.
SQL="UPDATE users SET is_curator = ${VALUE}, updated_at = strftime('%s','now') WHERE handle = '${LC_HANDLE}';"

npx wrangler d1 execute DB ${TARGET} --command "${SQL}"

# Confirm the result so a typo'd handle is obvious.
npx wrangler d1 execute DB ${TARGET} --command \
  "SELECT id, handle, is_curator FROM users WHERE handle = '${LC_HANDLE}';"
