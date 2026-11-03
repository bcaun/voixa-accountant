#!/usr/bin/env bash
# Pull the latest code and restart. Database migrations run automatically on start.
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
mkdir -p deploy/secrets  # key files the app reads (see DEPLOY.md); never committed
docker compose -f deploy/docker-compose.prod.yml up -d --build
# pick up Caddyfile changes (new sites, headers) without a restart
docker compose -f deploy/docker-compose.prod.yml exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
docker image prune -f >/dev/null
docker compose -f deploy/docker-compose.prod.yml ps
