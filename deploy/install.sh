#!/usr/bin/env bash
# First-time setup of Voixa Exchange on a fresh Ubuntu 24.04 server. Run as root from the repository:
#   bash deploy/install.sh app.pescada.io you@voixa.es "Your Name"
# Safe to run again: it keeps an existing deploy/.env and only (re)starts the containers.
set -euo pipefail

DOMAIN="${1:?usage: deploy/install.sh <domain> <accountant email> <accountant name>}"
ACC_EMAIL="${2:?accountant email missing}"
ACC_NAME="${3:-}"
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

echo "==> System updates and security tools"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -yq
apt-get install -yq ufw fail2ban unattended-upgrades curl git openssl
dpkg-reconfigure -f noninteractive unattended-upgrades

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi

echo "==> Firewall: SSH, HTTP and HTTPS only"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

# app.pescada.io -> mail from pescada.io; pescada.io -> pescada.io
MAIL_DOMAIN="$DOMAIN"
if [ "$(echo "$DOMAIN" | tr -cd '.' | wc -c)" -ge 2 ]; then MAIL_DOMAIN="${DOMAIN#*.}"; fi

ENV_FILE="$ROOT/deploy/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "==> Creating $ENV_FILE with new secrets"
  cat > "$ENV_FILE" <<ENV
DOMAIN=$DOMAIN
POSTGRES_PASSWORD=$(openssl rand -hex 24)
FIRM_NAME=Voixa Accounting
WEBHOOK_TOKEN=$(openssl rand -hex 24)

# Files on this server's disk for now. Switch to s3 (Cloudflare R2 / Backblaze B2) later, see DEPLOY.md.
STORAGE_DRIVER=fs
MAX_UPLOAD_MB=25

# Email: "console" only writes emails to the app log. Set up Postmark, then change to postmark (DEPLOY.md).
MAIL_TRANSPORT=console
MAIL_FROM=Voixa Exchange <notifications@$MAIL_DOMAIN>
# POSTMARK_TOKEN=

# AI reading of PDFs and photos. Without a key, Norma 43 / camt.053 / CSV statements are still read.
# ANTHROPIC_API_KEY=
RECOGNITION_AI=on
AI_MONTHLY_BUDGET_USD=0
ENV
  chmod 600 "$ENV_FILE"
fi

echo "==> Building and starting the containers"
docker compose -f deploy/docker-compose.prod.yml up -d --build

echo "==> Waiting for the app"
for i in $(seq 1 60); do
  if docker compose -f deploy/docker-compose.prod.yml exec -T app wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1; then break; fi
  sleep 2
done

echo "==> Accountant account"
docker compose -f deploy/docker-compose.prod.yml exec -T app node src/cli.js create-accountant --email "$ACC_EMAIL" --name "$ACC_NAME"

echo
echo "Done. Open the sign-in link above (it works once, for 30 minutes)."
echo "Another link later:  docker compose -f deploy/docker-compose.prod.yml exec app node src/cli.js login-link --email $ACC_EMAIL"
