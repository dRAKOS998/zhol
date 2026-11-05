#!/usr/bin/env bash
# Install or update the Zhol game server on this VPS. Run bootstrap.sh once first.
#   First run:  curl -fsSL <raw url of this file> | sudo bash -s -- "<frontend origins>"
#   Update:     sudo update-zhol
#   New origin: sudo update-zhol "https://zhol.example.com,https://zhol.vercel.app"
#   New domain: sudo ZHOL_HOST=api.zhol.example.com update-zhol
# Frontend origins are comma-separated; the first one is used for invite links.
# A failed build leaves the running server untouched. The script exits non-zero if the server
# is not healthy afterwards.
#
# Auto-deploy: a systemd timer runs "update-zhol --if-changed" every minute. It restarts the server
# only when a push touches backend files; a commit that failed is not retried until a newer one lands.
# The last deployed commit is published at /deployed-commit so Vercel can wait for the backend.
#   Pause: sudo systemctl disable --now zhol-autodeploy.timer
#   Logs:  journalctl -u zhol-autodeploy -f
set -euo pipefail

REPO="${ZHOL_REPO:-https://github.com/dRAKOS998/zhol.git}"
BRANCH="${ZHOL_BRANCH:-main}"
APP_DIR=/srv/zhol
DATA_DIR=/var/lib/zhol
ENV_FILE="$APP_DIR/apps/server/.env"
SITE_FILE=/etc/caddy/sites/zhol.caddy
PORT=3001
STATUS_DIR=/srv/zhol-status
FAILED_FILE="$DATA_DIR/autodeploy-failed-commit"
# A push touching anything else (the web app, docs) needs no backend restart.
BACKEND_PATHS='^(apps/server/|packages/|package\.json$|package-lock\.json$|deploy/vps/zhol\.sh$)'

die() { echo "ERROR: $*" >&2; exit 1; }

as_zhol() { sudo -u zhol -H "$@"; }

publish_commit() { as_zhol git -C "$APP_DIR" rev-parse HEAD > "$STATUS_DIR/deployed-commit"; }

# Timer entry point. Returns 0 to go on with a full deploy; exits when there is nothing to build.
check_for_changes() {
  [ -d "$APP_DIR/.git" ] || die "Not installed yet"
  local remote deployed changed
  remote="$(as_zhol git -C "$APP_DIR" ls-remote origin "refs/heads/$BRANCH" | cut -f1)" || exit 0
  [ -n "$remote" ] || exit 0
  # Compare with the last successful deploy, not HEAD: after a failed build HEAD is ahead of what runs.
  deployed="$(cat "$STATUS_DIR/deployed-commit" 2>/dev/null || true)"
  [ "$remote" != "$deployed" ] || exit 0
  if [ "$remote" = "$(cat "$FAILED_FILE" 2>/dev/null || true)" ]; then exit 0; fi

  as_zhol git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  # If the two commits cannot be compared, assume the backend changed.
  changed="$(as_zhol git -C "$APP_DIR" diff --name-only "$deployed" FETCH_HEAD 2>/dev/null)" || changed=apps/server/
  if ! printf '%s\n' "$changed" | grep -Eq "$BACKEND_PATHS"; then
    as_zhol git -C "$APP_DIR" reset --hard FETCH_HEAD
    publish_commit
    echo "==> $remote changes no backend files; no restart needed"
    exit 0
  fi
  echo "==> Deploying $remote"
  # shellcheck disable=SC2064 # the commit is fixed now, on purpose
  trap "[ \$? -eq 0 ] || echo '$remote' > '$FAILED_FILE'" EXIT
}

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

  # One deploy at a time: the timer steps aside for a manual run, and the other way round is an error.
  exec 9>/run/zhol-deploy.lock
  if ! flock -n 9; then
    [ "${1:-}" = "--if-changed" ] && exit 0
    die "Another deploy is running: journalctl -u zhol-autodeploy -f"
  fi
  if [ "${1:-}" = "--if-changed" ]; then
    check_for_changes
    shift
  fi

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

  cat > /etc/systemd/system/zhol-autodeploy.service <<UNIT
[Unit]
Description=Deploy new Zhol commits
After=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/bin/update-zhol --if-changed
UNIT

  cat > /etc/systemd/system/zhol-autodeploy.timer <<UNIT
[Unit]
Description=Check for new Zhol commits every minute
[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
[Install]
WantedBy=timers.target
UNIT

  install -d "$STATUS_DIR"
  cat > "$SITE_FILE" <<SITE
$host {
	encode gzip
	handle /deployed-commit {
		root * $STATUS_DIR
		file_server
	}
	handle {
		reverse_proxy 127.0.0.1:$PORT
	}
}
SITE

  install -m 755 "$APP_DIR/deploy/vps/zhol.sh" /usr/local/bin/update-zhol

  systemctl daemon-reload
  systemctl enable zhol >/dev/null
  systemctl restart zhol
  systemctl reload caddy
  # After the first install or a manual run the timer may already be active; --now is safe either way.
  systemctl enable --now zhol-autodeploy.timer >/dev/null 2>&1

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

  publish_commit
  rm -f "$FAILED_FILE"

  echo
  echo "Zhol backend:      https://$host   (set this as VITE_SERVER_URL on Vercel)"
  echo "Allowed frontends: $(grep '^ALLOWED_ORIGINS=' "$ENV_FILE" | cut -d= -f2)"
  echo "Database:          $DATA_DIR/zhol.db"
  echo "Deployed commit:   $(cat "$STATUS_DIR/deployed-commit")"
  echo "Auto-deploy:       on (checks every minute). Deploy now with: sudo update-zhol"
}

main "$@"
