#!/usr/bin/env bash
# One-time VPS preparation for the game servers (Ubuntu 24.04).
# Installs Node.js 22, Caddy (automatic HTTPS), git, a firewall, swap and automatic security updates.
# Safe to re-run.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: curl -fsSL <url> | sudo bash"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "==> System update"
apt-get update -y
apt-get upgrade -y
apt-get install -y curl git ca-certificates gnupg ufw unattended-upgrades debian-keyring debian-archive-keyring apt-transport-https build-essential python3

echo "==> Automatic security updates"
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "==> 2 GB swap (keeps builds from running out of memory)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -w vm.swappiness=10 >/dev/null && echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf

echo "==> Node.js 22"
if ! node -v 2>/dev/null | grep -q '^v22\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "==> Caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi
mkdir -p /etc/caddy/sites
cat > /etc/caddy/Caddyfile <<'CADDY'
# Each game adds its own site file in /etc/caddy/sites/.
import /etc/caddy/sites/*.caddy
CADDY
systemctl enable --now caddy
systemctl reload caddy || systemctl restart caddy

echo "==> Firewall: SSH, HTTP, HTTPS only"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable

echo
echo "Done. Node $(node -v), $(caddy version | cut -d' ' -f1)."
