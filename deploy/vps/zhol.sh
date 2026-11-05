#!/usr/bin/env bash
# Install or update the Zhol game server on this VPS. Run bootstrap.sh once first.
#   First run:  curl -fsSL <raw url of this file> | sudo bash -s -- "<frontend origins>"
#   Update:     sudo update-zhol
#   New origin: sudo update-zhol "https://zhol.example.com,https://zhol.vercel.app"
#   New domain: sudo ZHOL_HOST=api.zhol.example.com update-zhol
# Frontend origins are comma-separated; the first one is used for invite links.
# A failed build leaves the running server untouched. The script exits non-zero if the server
# is not healthy afterwards.
set -euo pipefail

REPO="${ZHOL_REPO:-https://github.com/dRAKOS998/zhol.git}"
BRANCH="${ZHOL_BRANCH:-main}"
APP_DIR=/srv/zhol
DATA_DIR=/var/lib/zhol
ENV_FILE="$APP_DIR/apps/server/.env"
SITE_FILE=/etc/caddy/sites/zhol.caddy
PORT=3001

die() { echo "ERROR: $*" >&2; exit 1; }

set_env() { # KEY VALUE: replace the key in the env file, keeping every other line.
  { grep -v "^$1=" "$ENV_FILE" || true; echo "$1=$2"; } > "$ENV_FILE.new"
  mv "$ENV_FILE.new" "$ENV_FILE"
}

# Everything runs from main() so a truncated download does nothing, and so no command can
# swallow the rest of the script when it is piped into bash.
main() {
  [ "$(id -u)" -eq 0 ] || die "Run with sudo"
  node -v 2>/dev/null | grep -q '^v22\.' || die "Node.js 22 not found. Run bootstrap.sh first."
  [ -d /etc/caddy/sites ] || die "/etc/caddy/sites not found. Run bootstrap.sh first."

  local origins="${1:-${ZHOL_ORIGINS:-}}" origin host public_ip
  origins="$(printf '%s' "$origins" | tr -d '[:space:]')"
  [ -n "$origins" ] || [ -f "$ENV_FILE" ] || die "Pass the frontend origin(s), e.g. https://zhol.vercel.app"
  # Same rule as apps/server/src/config.ts, checked here so a typo cannot take the server down.
  for origin in ${origins//,/ }; do
    [[ "$origin" =~ ^https?://[^/]+$ ]] || die "Not an origin (no path or trailing slash): $origin"
  done

  # Backend hostname: ZHOL_HOST if given, else the one already configured, else a free sslip.io name.
  if [ -n "${ZHOL_HOST:-}" ]; then
    host="$ZHOL_HOST"
  elif [ -f "$SITE_FILE" ]; then
    host="$(awk 'NR==1{print $1}' "$SITE_FILE")"
  else
    public_ip="$(curl -fsS4 https://api.ipify.org || hostname -I | awk '{print $1}')"
    host="zhol.${public_ip//./-}.sslip.io"
  fi

  id zhol >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/zhol --shell /usr/sbin/nologin zhol
  install -d -o zhol -g zhol "$APP_DIR"
  install -d -m 750 -o zhol -g zhol "$DATA_DIR"

  echo "==> Fetching $BRANCH"
  if [ ! -d "$APP_DIR/.git" ]; then
    sudo -u zhol -H git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
  else
    sudo -u zhol -H git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
    sudo -u zhol -H git -C "$APP_DIR" reset --hard FETCH_HEAD
  fi

  echo "==> Installing and building the server"
  cd "$APP_DIR"
  sudo -u zhol -H env PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --include=dev --no-audit --no-fund
  sudo -u zhol -H npm run build -w @zhol/server

  if [ ! -f "$ENV_FILE" ]; then
    cat > "$ENV_FILE" <<ENV
NODE_ENV=production
HOST=127.0.0.1
PORT=$PORT
TRUST_PROXY=true
DATABASE_PATH=$DATA_DIR/zhol.db
ENV
  fi
  if [ -n "$origins" ]; then
    set_env ALLOWED_ORIGINS "$origins"
    set_env PUBLIC_WEB_URL "${origins%%,*}"
  fi
  chown zhol:zhol "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  # ProtectSystem=strict makes the filesystem read-only, so the database directory must be listed.
  cat > /etc/systemd/system/zhol.service <<UNIT
[Unit]
Description=Zhol game server
After=network.target
[Service]
Type=simple
User=zhol
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node apps/server/dist/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
MemoryMax=600M
[Install]
WantedBy=multi-user.target
UNIT

  cat > "$SITE_FILE" <<SITE
$host {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
SITE

  install -m 755 "$APP_DIR/deploy/vps/zhol.sh" /usr/local/bin/update-zhol

  systemctl daemon-reload
  systemctl enable zhol >/dev/null
  systemctl restart zhol
  systemctl reload caddy

  echo "==> Checking"
  local i
  for i in $(seq 1 20); do curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 || die "Server is not healthy: journalctl -u zhol -n 50"
  echo "  server OK"
  for i in $(seq 1 30); do curl -fsS "https://$host/health" >/dev/null 2>&1 && break; sleep 2; done
  if curl -fsS "https://$host/health" >/dev/null 2>&1; then
    echo "  HTTPS OK"
  else
    echo "  HTTPS not ready yet (the certificate may take a minute): journalctl -u caddy -n 30"
  fi

  echo
  echo "Zhol backend:      https://$host   (set this as VITE_SERVER_URL on Vercel)"
  echo "Allowed frontends: $(grep '^ALLOWED_ORIGINS=' "$ENV_FILE" | cut -d= -f2)"
  echo "Database:          $DATA_DIR/zhol.db"
  echo "Update later with: sudo update-zhol"
}

main "$@"
