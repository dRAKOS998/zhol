#!/usr/bin/env bash
# Install or update the LETRA game server on this VPS.
#   First run:  curl -fsSL <url> | sudo bash -s -- "<frontend origins>"
#   Update:     sudo update-letra
# The repository is private, so the first run creates a read-only deploy key and stops until
# that key is added to GitHub (dRAKOS998/letra -> Settings -> Deploy keys).
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo"; exit 1; }

REPO="git@github.com:dRAKOS998/letra.git"
BRANCH="${LETRA_BRANCH:-letra/pishpirik-release}"
APP_DIR=/srv/letra
PORT=3002
PUBLIC_IP="$(curl -fsS4 https://api.ipify.org || hostname -I | awk '{print $1}')"
HOST="${LETRA_HOST:-letra.${PUBLIC_IP//./-}.sslip.io}"
ORIGINS="${1:-${LETRA_CORS_ORIGINS:-}}"

id letra >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/letra --shell /usr/sbin/nologin letra
KEY=/home/letra/.ssh/id_ed25519
if [ ! -f "$KEY" ]; then
  install -d -m 700 -o letra -g letra /home/letra/.ssh
  sudo -u letra ssh-keygen -q -t ed25519 -N '' -C "letra-vps-deploy" -f "$KEY"
fi
sudo -u letra bash -c 'ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null; sort -u -o ~/.ssh/known_hosts ~/.ssh/known_hosts'

if ! sudo -u letra -H git ls-remote "$REPO" >/dev/null 2>&1; then
  echo
  echo "=================================================================="
  echo " Add this READ-ONLY deploy key to GitHub, then run this script again:"
  echo " github.com/dRAKOS998/letra -> Settings -> Deploy keys -> Add deploy key"
  echo " Title: webdock-vps   (leave 'Allow write access' unticked)"
  echo
  cat "$KEY.pub"
  echo "=================================================================="
  exit 2
fi

[ -n "$ORIGINS" ] || [ -f "$APP_DIR/server/.env" ] || { echo "Pass the frontend origin(s), e.g. https://letra.vercel.app"; exit 1; }

echo "==> Fetching $BRANCH"
install -d -o letra -g letra "$APP_DIR"
if [ ! -d "$APP_DIR/.git" ]; then
  sudo -u letra -H git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
else
  sudo -u letra -H git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  sudo -u letra -H git -C "$APP_DIR" reset --hard FETCH_HEAD
fi

echo "==> Installing and building the server"
cd "$APP_DIR"
sudo -u letra -H env PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --include=dev --no-audit --no-fund
sudo -u letra -H npm run build -w server

if [ -n "$ORIGINS" ]; then
  cat > "$APP_DIR/server/.env" <<ENV
NODE_ENV=production
PORT=$PORT
CORS_ORIGINS=$ORIGINS
BOT_MOVE_MIN_MS=800
BOT_MOVE_MAX_MS=2000
ENV
  chown letra:letra "$APP_DIR/server/.env"; chmod 600 "$APP_DIR/server/.env"
fi

cat > /etc/systemd/system/letra.service <<UNIT
[Unit]
Description=LETRA game server
After=network.target
[Service]
Type=simple
User=letra
WorkingDirectory=$APP_DIR/server
EnvironmentFile=$APP_DIR/server/.env
ExecStart=/usr/bin/node $APP_DIR/server/dist/server/src/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
MemoryMax=600M
[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/caddy/sites/letra.caddy <<SITE
$HOST {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
SITE

cp "$0" /usr/local/bin/update-letra 2>/dev/null || curl -fsSL https://raw.githubusercontent.com/dRAKOS998/zhol/main/deploy/vps/letra.sh -o /usr/local/bin/update-letra
chmod 755 /usr/local/bin/update-letra

systemctl daemon-reload
systemctl enable letra >/dev/null
systemctl restart letra
systemctl reload caddy

echo "==> Checking"
for i in $(seq 1 20); do curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:$PORT/health" && echo "  server OK"
for i in $(seq 1 30); do curl -fsS "https://$HOST/health" >/dev/null 2>&1 && break; sleep 2; done
if curl -fsS "https://$HOST/health" >/dev/null 2>&1; then echo "  HTTPS OK"; else echo "  HTTPS not ready yet (certificate may take a minute): journalctl -u caddy -n 30"; fi
echo
echo "LETRA backend: https://$HOST"
echo "Allowed frontends: $(grep CORS_ORIGINS "$APP_DIR/server/.env" | cut -d= -f2)"
echo "Update later with: sudo update-letra"
