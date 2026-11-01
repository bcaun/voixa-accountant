#!/usr/bin/env bash
# Proves that the newest nightly backup can be restored: loads it into a throwaway PostgreSQL
# next to the real one, checks every client's log with the app's own verification, prints
# what it found, and removes the throwaway database. The live database is not touched.
#   bash deploy/restore-test.sh
set -euo pipefail
cd "$(dirname "$0")"
compose="docker compose -f docker-compose.prod.yml"
DUMP=$($compose exec -T backup sh -c 'ls -1t /backups/voixa-*.sql.gz 2>/dev/null | head -1' | tr -d '\r')
if [ -z "$DUMP" ]; then echo "No backup found in the backups volume yet."; exit 1; fi
echo "==> Newest backup: $DUMP"
NET=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$($compose ps -q db)" | awk '{print $1}')
docker run -d --rm --name pescada-restore-test --network "$NET" \
  -e POSTGRES_USER=voixa -e POSTGRES_DB=voixa -e POSTGRES_PASSWORD=restore-test postgres:16 >/dev/null
trap 'docker stop pescada-restore-test >/dev/null 2>&1 || true' EXIT
echo "==> Starting a throwaway database"
until docker exec pescada-restore-test pg_isready -U voixa -d voixa >/dev/null 2>&1; do sleep 1; done
sleep 2
echo "==> Restoring"
$compose exec -T backup sh -c "cat '$DUMP'" | gunzip | docker exec -i pescada-restore-test psql -q -v ON_ERROR_STOP=1 -U voixa -d voixa >/dev/null
echo "==> Checking every client's log in the restored copy"
$compose run --rm -T --no-deps -e SCHEDULER=off -e DATABASE_URL=postgres://voixa:restore-test@pescada-restore-test:5432/voixa app node src/cli.js verify-all
echo "==> Restore test passed. The throwaway database is removed."
