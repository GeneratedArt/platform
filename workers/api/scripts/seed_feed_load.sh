#!/usr/bin/env bash
# Smoke + load seed for the activity feed (Task #17).
#
# Builds a viewer (id=900) following 100 actors (901..1000) with 1000
# public events spread across them, plus 50 unread notifications
# addressed to the viewer (mix of follow / brief_application /
# featured / mint). Then prints:
#   - row counts
#   - the EXPLAIN QUERY PLAN for the feed query
#   - wall-clock timing for a 50-row feed read and the unread badge
#
# Usage: bash workers/api/scripts/seed_feed_load.sh
# Targets the local D1 DB by default. Pass --remote to run on prod.

set -euo pipefail
cd "$(dirname "$0")/.."

REMOTE_FLAG="--local"
if [ "${1:-}" = "--remote" ]; then REMOTE_FLAG="--remote"; fi

NUM_ACTORS=100
NUM_EVENTS=1000
NUM_NOTIFS=50

echo ">>> seeding $NUM_ACTORS actors + $NUM_EVENTS events + $NUM_NOTIFS notifications"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# 1. viewer + actors + follows. D1 wraps --file in its own txn, so we
# don't (and can't) emit BEGIN/COMMIT ourselves.
{
  echo "DELETE FROM events WHERE actor_id BETWEEN 900 AND $((900 + NUM_ACTORS));"
  echo "DELETE FROM follows WHERE follower_id = 900;"
  echo "INSERT OR IGNORE INTO users (id,address,handle,created_at,updated_at) VALUES (900,'0x9000000000000000000000000000000000000000','feed-viewer',1700000000,1700000000);"
  for i in $(seq 1 "$NUM_ACTORS"); do
    uid=$((900 + i))
    addr=$(printf '0x90%038x' "$i")
    echo "INSERT OR IGNORE INTO users (id,address,handle,created_at,updated_at) VALUES ($uid,'$addr','feed-actor-$i',1700000000,1700000000);"
    echo "INSERT OR IGNORE INTO follows (follower_id,followed_id,created_at) VALUES (900,$uid,1700000000);"
  done
} > "$tmp/01_users.sql"
npx wrangler d1 execute DB $REMOTE_FLAG --file="$tmp/01_users.sql" >/dev/null

# 2. 1000 public events, batched 200/file (wrangler chokes on bigger).
seq 1 "$NUM_EVENTS" | awk -v num_actors="$NUM_ACTORS" '
  BEGIN { kinds[0]="commit"; kinds[1]="freeze"; kinds[2]="mint"; kinds[3]="brief_posted"; }
  {
    actor = 900 + (($0 - 1) % num_actors) + 1
    ts = 1700000000 + $0
    k = kinds[$0 % 4]
    printf "INSERT INTO events (kind,actor_id,target_kind,target_id,recipient_id,payload_json,created_at) VALUES (%c%s%c,%d,%cproject%c,%d,NULL,%c{\"title\":\"p%d\",\"project_id\":%d}%c,%d);\n", 39,k,39, actor, 39,39, $0, 39, $0, $0, 39, ts
  }' > "$tmp/events_raw.sql"
split -l 200 "$tmp/events_raw.sql" "$tmp/ev_"
for f in "$tmp"/ev_*; do
  [ -f "$f" ] || continue
  case "$f" in *.sql) continue ;; esac
  mv "$f" "$f.sql"
  npx wrangler d1 execute DB $REMOTE_FLAG --file="$f.sql" >/dev/null
done

# 3. Notifications addressed to viewer (varied kinds).
{
  for i in $(seq 1 "$NUM_NOTIFS"); do
    actor=$((900 + (i % NUM_ACTORS) + 1))
    ts=$((1700100000 + i))
    case $((i % 4)) in
      0) k="follow";            tk="user";    tid=900;          payload="{\"handle\":\"feed-actor-$i\"}";;
      1) k="brief_application"; tk="brief";   tid=$((1000 + i)); payload="{\"brief_id\":$((1000+i)),\"title\":\"Brief $i\"}";;
      2) k="featured";          tk="project"; tid=$i;            payload="{\"project_id\":$i,\"title\":\"Project $i\"}";;
      3) k="mint";              tk="project"; tid=$i;            payload="{\"project_id\":$i,\"title\":\"Project $i\"}";;
    esac
    echo "INSERT INTO events (kind,actor_id,target_kind,target_id,recipient_id,payload_json,created_at) VALUES ('$k',$actor,'$tk',$tid,900,'$payload',$ts);"
  done
} > "$tmp/03_notifs.sql"
npx wrangler d1 execute DB $REMOTE_FLAG --file="$tmp/03_notifs.sql" >/dev/null

echo ">>> row counts"
npx wrangler d1 execute DB $REMOTE_FLAG --command="
  SELECT
    (SELECT COUNT(*) FROM follows  WHERE follower_id = 900)         AS follows,
    (SELECT COUNT(*) FROM events   WHERE recipient_id IS NULL)      AS public_events,
    (SELECT COUNT(*) FROM events   WHERE recipient_id = 900)        AS notifications,
    (SELECT COUNT(*) FROM events   WHERE recipient_id = 900 AND read_at IS NULL) AS unread;" \
  | tail -20

echo ">>> EXPLAIN QUERY PLAN feed"
npx wrangler d1 execute DB $REMOTE_FLAG --command="
  EXPLAIN QUERY PLAN
  SELECT e.id FROM events e
    JOIN follows f ON f.followed_id = e.actor_id
   WHERE f.follower_id = 900 AND e.recipient_id IS NULL
   ORDER BY e.created_at DESC, e.id DESC LIMIT 51;" | tail -25

echo ">>> 50-row feed read timing"
start=$(date +%s%N)
npx wrangler d1 execute DB $REMOTE_FLAG --command="
  SELECT e.id FROM events e
    JOIN follows f ON f.followed_id = e.actor_id
   WHERE f.follower_id = 900 AND e.recipient_id IS NULL
   ORDER BY e.created_at DESC, e.id DESC LIMIT 50;" >/dev/null
end=$(date +%s%N)
echo "feed wall-clock: $(( (end - start) / 1000000 )) ms (incl. wrangler overhead)"

echo ">>> unread badge timing"
start=$(date +%s%N)
npx wrangler d1 execute DB $REMOTE_FLAG --command="
  SELECT COUNT(*) FROM events WHERE recipient_id = 900 AND read_at IS NULL;" >/dev/null
end=$(date +%s%N)
echo "badge wall-clock: $(( (end - start) / 1000000 )) ms (incl. wrangler overhead)"
