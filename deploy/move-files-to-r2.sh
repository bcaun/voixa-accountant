#!/usr/bin/env bash
# Copy files uploaded while STORAGE_DRIVER=fs into the R2 bucket, under the same keys,
# so they keep opening after the switch to STORAGE_DRIVER=s3. Safe to run more than once.
set -euo pipefail
cd "$(dirname "$0")/.."
compose="docker compose -f deploy/docker-compose.prod.yml"
$compose run --rm -T -v voixa-exchange_files:/files:ro offsite \
  'test -n "$S3_BUCKET" || { echo "Set the S3_* settings in deploy/.env first"; exit 1; }
   rclone copy /files "r2:$S3_BUCKET" --stats-one-line -v
   echo "--- on this server:"; find /files -type f | wc -l
   echo "--- in the bucket (companies/):"; rclone size "r2:$S3_BUCKET/companies"'
