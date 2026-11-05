# Zhol

A real-time, four-player tile game for friends. One player creates a room, shares a single link, and four people play a four-round tournament from phones or computers. The interface and in-game rules are in Albanian; code and developer docs are in English.

The server is authoritative: clients send intents, the server validates them against a pure rules engine, commits to SQLite, and sends each player only the view they are allowed to see.

```
apps/web          React 19 + Vite + Tailwind CSS 4 — home, invite route, lobby, table, rack, scoreboard, socket client
apps/server       Express 5 + Socket.IO 4 — handlers, room sessions, SQLite persistence (better-sqlite3), /health
packages/engine   Pure TypeScript — tiles, dealing, legal moves, hand solver, scoring, turn state machine
packages/protocol Shared event contracts, zod runtime validation, error codes, public/private view types
```

## Requirements

- **Node.js 22 LTS (≥ 22.12)** and npm 10. (`.nvmrc` pins 22.)
- A C/C++ toolchain is only needed if `better-sqlite3` has no prebuilt binary for your platform (prebuilds exist for Linux, macOS and Windows on x64/arm64).

## Commands

All commands run from the repository root.

| Task | Command |
| --- | --- |
| Install | `npm ci` (or `npm install`) |
| Develop (server :3001 + web :5173) | `npm run dev` |
| Unit + integration tests | `npm test` |
| Browser smoke test | `npx playwright install chromium && npm run test:e2e` |
| Lint | `npm run lint` |
| Typecheck | `npm run typecheck` |
| Build (server bundle + web) | `npm run build` |
| Production server | `NODE_ENV=production npm start` (runs `apps/server/dist/index.js`) |

`npm test` runs the engine tests (solver, deal, state machine, scoring) and the Socket.IO integration tests (real server on a random port, temp SQLite file). The browser smoke test builds the web app, starts `vite preview` and a real server with the test harness, then drives four isolated browser contexts. To use an installed Chrome instead of Playwright's download: `PLAYWRIGHT_CHROME_PATH=/usr/bin/google-chrome npm run test:e2e`.

## Quick start

```bash
npm ci
cp apps/server/.env.example apps/server/.env   # optional; defaults work for local dev
npm run dev
```

1. Open http://localhost:5173, type your name, press **Krijo dhomë**.
2. In the lobby press **Kopjo lidhjen** and send the link (`http://<host>:5173/room/XXXXXXXX`) to three friends.
3. Each friend opens the link, types a name, presses **Hyr në dhomë**.
4. Everyone presses **Jam gati**. The game deals as soon as all four seats are ready.
5. The starter (chosen randomly) holds 15 tiles and only discards: tap a tile, then **Hidh**. The next player presses **Tërhiq një gur** (or takes the previous player's discard), then discards.
6. To close, tap the tile you want to throw last, press **Mbyll raundin**, then confirm.

To play from phones on the same Wi‑Fi, run `npm run dev`, open `http://<your-LAN-IP>:5173`, and add that origin to `ALLOWED_ORIGINS` in `apps/server/.env` (e.g. `ALLOWED_ORIGINS=http://localhost:5173,http://192.168.1.20:5173`).

### Testing four seats locally

Each seat's private credential is stored in that browser profile's `localStorage`, so four seats need four isolated storage contexts:

- Use one normal window, one private/incognito window, and two other browser profiles (Chrome: *Profiles → Add*; Firefox: Multi-Account Containers), **or**
- Run the automated four-context test: `npm run test:e2e`.

Opening the same room in two tabs of the same profile hands the seat to the newest tab; the older tab shows a notice with **Luaj këtu** to take it back.

## Environment variables

### Server (`apps/server/.env`, see `.env.example`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | HTTP + WebSocket port |
| `HOST` | `0.0.0.0` | Bind address |
| `ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated exact browser origins allowed to connect (the frontend origin) |
| `PUBLIC_WEB_URL` | — | Frontend origin; used to return absolute `inviteUrl`s |
| `DATABASE_PATH` | `./data/zhol.db` | SQLite file; must be on persistent storage in production |
| `TRUST_PROXY` | `false` | `true` behind nginx/Render so rate limits see the real client IP |
| `ZHOL_UNLINKED_PENALTY` | `20` | House rule: penalty for an unlinked Zhol |
| `NODE_ENV` | — | `production` in production |
| `ZHOL_TEST_HARNESS` | — | Test-only deal rigging. Refuses to start unless `NODE_ENV=test`; never set in production |

### Web (`apps/web/.env`, see `.env.example`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_SERVER_URL` | `http(s)://<page host>:3001` | Backend URL (HTTPS in production). Public by nature; no secrets go here. |

## Deployment

### Backend on Render (blueprint included)

1. Push the repo to GitHub and create a **Blueprint** from `render.yaml`. It defines one Node web service with a **1 GB persistent disk at `/var/data`** (`DATABASE_PATH=/var/data/zhol.db`) and `/health` as the health check.
2. Set `ALLOWED_ORIGINS` and `PUBLIC_WEB_URL` to the Vercel origin, e.g. `https://zhol.vercel.app` (add any custom domain too).
3. Render terminates HTTPS and proxies WebSockets automatically. Run exactly **one instance**: room state is serialized in-process.

### Backend on a VPS

```bash
# as a deploy user, Node 22 installed
git clone <repo> /srv/zhol && cd /srv/zhol
npm ci && npm run build -w @zhol/server
sudo mkdir -p /var/lib/zhol && sudo chown $USER /var/lib/zhol
```

systemd unit `/etc/systemd/system/zhol.service`:

```ini
[Unit]
Description=Zhol game server
After=network.target

[Service]
WorkingDirectory=/srv/zhol
ExecStart=/usr/bin/node apps/server/dist/index.js
Environment=NODE_ENV=production PORT=3001 HOST=127.0.0.1 TRUST_PROXY=true
Environment=DATABASE_PATH=/var/lib/zhol/zhol.db
Environment=ALLOWED_ORIGINS=https://zhol.vercel.app PUBLIC_WEB_URL=https://zhol.vercel.app
Restart=always
User=deploy

[Install]
WantedBy=multi-user.target
```

nginx with HTTPS (certbot) and WebSocket upgrade:

```nginx
server {
  server_name api.zhol.example;
  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 120s;
  }
  listen 443 ssl; # managed by certbot
}
```

Back up `/var/lib/zhol/zhol.db*` (WAL mode: copy with `sqlite3 zhol.db ".backup backup.db"`).

### Frontend on Vercel

1. Import the repo, set **Root Directory** to `apps/web`. `apps/web/vercel.json` installs from the monorepo root, builds with `npm run build`, serves `dist`, and **rewrites every non-asset path to `/index.html`** so invite links like `/room/ABCD2345` load directly.
2. Set `VITE_SERVER_URL=https://<your-backend>` for Production (and Preview if desired). Add every frontend origin you use (including preview URLs if you test them) to the server's `ALLOWED_ORIGINS`.

## Architecture notes

- **Engine** (`packages/engine`): `applyAction(state, seat, action, ctx)` is a pure reducer returning a new state or an error code. Phases: `LOBBY → AWAITING_DISCARD/AWAITING_DRAW → ROUND_RESULT → … → TOURNAMENT_COMPLETE`. Randomness is injected (`crypto.randomInt` in production, a seeded generator in tests). Deals use Fisher–Yates and a uniformly chosen numbered indicator; every deal asserts 57 + 1 + 48 = 106.
- **Solver**: `evaluateHand` enumerates every legal run/set with physical tile IDs and wildcard assignments, then runs a memoized bitmask search over the lowest remaining tile (leave it unlinked, or place it in each fitting candidate). It returns the grouping, unlinked IDs, minimum penalty and full-cover flag, with a deterministic tie-break, and is the single source for both close validation and loser scoring. Tests compare it against an exhaustive reference on 600 random hands.
- **Server**: commands are validated with zod, the acting seat comes from the socket binding (never the payload), and each mutation is one synchronous SQLite transaction (room state + immutable `round_results` row + idempotency record) committed before any broadcast. `(seat, requestId)` replays return the stored outcome; `dealId`/`turnId` reject stale commands; `sort_rack` never changes `turnId`. Seat credentials are 256-bit tokens stored only as SHA-256 hashes; invite links contain only the room code.
- **Views**: each socket receives `{ you: { seat, rack }, state: PublicState }`. `PublicState` holds names, connectivity, readiness, active seat, phase, indicator, discard tops, stock count, rack counts and the full scored history — enough to rebuild the scoreboard after a reconnect.

## Rregullat (përmbledhje)

**Gurët.** 106 gurë: numrat 1–13 në katër ngjyra (e kuqe, e zezë, blu, e verdhë), nga dy kopje, plus dy gurë Zhol. Një gur numër kthehet si tregues: shërben vetëm për informacion. Vetëm dy gurët Zhol janë gurë të lirë.

**Ndarja.** Ai që fillon merr 15 gurë dhe vetëm hedh një gur; të tjerët marrin 14. Lojtari i parë zgjidhet rastësisht, loja shkon në drejtim të akrepave dhe pas çdo raundi të mbyllur fillon lojtari tjetër, kështu secili fillon një herë.

**Radha.** Tërhiq një gur nga stoku ose merr gurin e fundit që hodhi lojtari para teje, pastaj hidh një gur.

**Lidhjet.** *Varg*: 3–13 numra rresht me të njëjtën ngjyrë (blu 1‑2‑3‑4); pas 13 nuk vjen 1. *Grup*: 3 ose 4 gurë me të njëjtin numër dhe ngjyra të ndryshme; dy gurë me të njëjtën ngjyrë nuk hyjnë në një grup. *Zhol* zë vendin e një guri që mungon; dy Zhol zënë dy vende të ndryshme. Renditja në raft nuk ndikon.

**Mbyllja.** Me 15 gurë, zgjidh gurin e fundit, shtyp «Mbyll raundin» dhe konfirmo. Vlen vetëm nëse të 14 gurët e mbetur ndahen të gjithë në vargje dhe grupe. Shtatë çifte nuk mbyllin. Një hedhje e zakonshme nuk mbyll kurrë.

**Pikët.** Kush mbyll: −20. Kush mbyll duke hedhur një Zhol: −40 (Zhol-i brenda lidhjeve nuk jep bonus). Të tjerët marrin shumën më të vogël të mundshme të gurëve pa lidhje: vlera e shkruar, 20 për një Zhol pa lidhje (p.sh. 5 e kuqe + 12 e zezë = +17). Rafti plotësisht i lidhur jep 0.

**Dorë e bllokuar.** Kush tërheq gurin e fundit të stokut mund të mbyllë. Nëse vetëm hedh, dora bllokohet dhe gurët ndahen sërish për të njëjtin raund, me të njëjtin fillues; pikët nuk ndryshojnë.

**Fituesi.** Pas katër raundeve fiton kush ka më pak pikë. Nëse disa ndajnë rezultatin më të ulët, fitojnë bashkë.
