#!/usr/bin/env bash
# Pull the latest code and restart. Database migrations run automatically on start.
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
docker compose -f deploy/docker-compose.prod.yml up -d --build
docker image prune -f >/dev/null
docker compose -f deploy/docker-compose.prod.yml ps
