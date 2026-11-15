# UniOB (Unified Observability)

[![CI](https://github.com/Cusnd/UniOB/actions/workflows/ci.yml/badge.svg)](https://github.com/Cusnd/UniOB/actions/workflows/ci.yml)
[![Release](https://github.com/Cusnd/UniOB/actions/workflows/release.yml/badge.svg)](https://github.com/Cusnd/UniOB/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

[简体中文](./README.md) | **English**

UniOB is a secure, read-only Linux server fleet monitoring, on-demand process inspection, and alerting system engineered for resource-constrained VPS hosts (1 GB / 2 GB RAM) and low-cost operation. It supports two feature-identical control-plane modes — **Cloudflare Workers Free Edge Hub (SCCH)** and **Self-Hosted `uniob-hub` (Rust Hub + Cloudflare External Watchdog)** — sharing a single agent binary, dashboard UI, and seamless live hot migration.

---

## 📚 Documentation

| Document | Description |
| :--- | :--- |
| **[☁️ Cloudflare Workers Deployment Guide (ZH)](./docs/deploy-cloudflare.md)** | Step-by-step setup for zero-server `$0/mo` edge monitoring on Workers Free + Zero Trust Access |
| **[🖥️ Self-Hosted `uniob-hub` & Migration Guide (ZH)](./docs/deploy-self-hosted.md)** | Dedicated VPS setup with Cloudflare Tunnel, Caddy/Nginx, external Watchdog, and live migration |
| **[🏗️ Architecture Deep-Dive (ZH)](./docs/ARCHITECTURE.md)** | v1 cost bottlenecks, 6 SCCH cost optimizations, smart migration protocol, and resolved engineering traps |
| **[🔌 HTTP & WebSocket API Reference](./docs/API.md)** | Complete REST API routes, Watchdog HMAC signatures, and Agent / Dashboard WebSocket protocols |
| **[📐 Technical Spec & 7-Dimension Cost Model (ZH)](./docs/SPEC.md)** | Data structures, ring-slab TSDB layout, and 10 / 50 / 200-node Cloudflare billing comparisons |
| **[🤝 Contributing](./CONTRIBUTING.md) · [🔒 Security Policy](./SECURITY.md) · [📝 Changelog](./CHANGELOG.md)** | Local checks, security boundaries, and release history |

---

## Architecture Overview (v2)

UniOB runs identically in **Direction B (Cloudflare SCCH Edge Hub)** and **Direction A (Self-Hosted `uniob-hub` + Cloudflare Watchdog)** modes:

- **`agent/` (`uniob-agent`)**: Static `musl` Rust agent reading `/proc` and `statvfs` directly (no `fork`/`exec` child shells). Strictly capped at `<= 2,621,440` bytes (`<= 2.5 MB`, enforced in CI), ~`3–6 MB` RSS, outbound-only `WSS (443)` with:
  - **Protocol v2 Cohort Batching & Edge Alert Flushing**: In Idle (`mode = 0`), buffers up to 12 `CompactMetricTuple` (16-number) points in memory and flushes one `mb` batch frame every 5 minutes aligned to UTC boundaries + deterministic `[0, 400)` ms jitter. Immediately flushes (`reason = "edge"`) on watermark crossings, `|Δcpu| >= 35%`, or host reboot so critical alerts suffer zero artificial delay.
  - **Two-Stage Canary Hot Migration (`agent/src/migrate.rs`)**: Verifies HMAC-SHA256 `ctrl.migrate` directives, timestamp window, monotonic `epoch` replay protection, and SSRF guards. Opens a canary connection to the target hub first, promotes once a valid `ctrl` frame arrives within `10s`, persists `/var/lib/uniob/endpoint_override.toml` (`StateDirectory=uniob`), and automatically rolls back to `fallback_url` if the new hub remains unreachable (`>= 300s` or `>= 10` failed reconnects).
  - **Read-Only Security Boundary**: Enumerated sampling modes (`0`/`1`/`2`), regex-free lexical `cmdline` sanitization, and `90s` client subscription leases that automatically downshift back to idle cohort batching.
- **`worker/` (`uniob-worker`)**: Built with Hono, Cloudflare D1, SQLite Durable Objects, and the WebSocket Hibernation API:
  - **Co-Located Single DO (`FleetHubDO`)**: Converges Agent WebSockets and Dashboard Client WebSockets in a single `FleetHubDO("global")` instance (**0 cross-DO RPCs**, `1 × 128 MB` instance billing), handles heartbeats at the edge via `setWebSocketAutoResponse` (`{"op":"ping"}` -> `{"t":"pong"}`), guards cold starts with `hub_meta.schema_version` (`0` repeated DDL), mirrors D1 config tables locally (`0` hot-path D1 queries), and writes ring-slab circular TSDB chunks (`metrics_chunk_10m` / `metrics_5m_chunk_1h` / `metrics_1h_chunk_1d`) with Welford streaming aggregation — letting **Cloudflare Workers Free (`100k` SQLite row writes/day) run up to ~112 Idle nodes or ~75 nodes with 2h/day live dashboard viewing**.
  - **Cloudflare Watchdog (`worker/src/watchdog.ts`)**: `*/5 * * * *` Cron Trigger + HMAC-SHA256 `POST /api/watchdog/ping` endpoint (`576` Worker requests/day on Free tier, 0 DO calls).
  - **D1 (`uniob-meta`)**: Stores node registry, notification channels, alert rules, incident history, and system settings.
- **`hub/` (`uniob-hub`)**: Standalone Rust Hub powered by Axum, Tokio-Tungstenite, and local SQLite WAL with zero cloud cost:
  - Exposes matching `/api/*`, `/api/agent/ws`, `/api/client/ws`, `/install.sh`, `/install-hub.sh`, `/releases/*`, and serves static `web/dist` assets.
  - Includes loopback host self-probing (`hub/src/self_probe.rs`, default `hub-local`).
  - Supports both **Cloudflare Zero Trust Access (`Cf-Access-Jwt-Assertion` RS256 JWKS)** and **Builtin PBKDF2 password sessions**, plus periodic signed heartbeats to the Cloudflare Watchdog (`hub/src/watchdog.rs`).
- **`web/` (`uniob-web`)**: React 19 + TypeScript + Vite + TailwindCSS v4 + uPlot SPA with visibility/idle auto-unsubscribe (`IDLE_TIMEOUT_MS = 10 min`) and guided **Migration & Mode** workflows (`HubMigrationPanel.tsx`).

### Repository Structure

```text
UniOB/
├── agent/                  # Static Linux musl monitoring probe (uniob-agent)
├── hub/                    # Self-hosted Rust + SQLite hub server (uniob-hub)
├── worker/                 # Cloudflare Workers + D1 + SCCH Durable Objects backend
├── web/                    # React 19 + TailwindCSS v4 + uPlot dashboard frontend
├── scripts/                # Hardened install.sh.tmpl & install-hub.sh.tmpl installers
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                  # Typecheck, web build, Worker tests, Rust fmt/clippy/tests
│   │   ├── release.yml             # Cross-compiled musl static binaries + SHA256SUMS + web tar.gz
│   │   └── deploy-cloudflare.yml   # Optional GitHub Actions Worker + D1 deployment workflow
│   ├── ISSUE_TEMPLATE/
│   └── pull_request_template.md
├── docs/                   # Deployment guides, ARCHITECTURE.md, API.md, SPEC.md
└── package.json            # Root convenience scripts (no npm workspaces)
```

---

## Mode 1: Cloudflare Workers Edge Hub (SCCH)

> For detailed illustrated steps (in Chinese), see [docs/deploy-cloudflare.md](./docs/deploy-cloudflare.md).

### Option A: Manual CLI Deployment

```bash
# 1. Install separate frontend and worker dependencies & build static assets
npm --prefix web install
npm --prefix worker install
npm run build:web

# 2. Create D1 database and update worker/wrangler.jsonc (d1_databases[0].database_id)
npx --prefix worker wrangler d1 create uniob-meta

# 3. Apply remote D1 schema migrations
npx --prefix worker wrangler d1 migrations apply uniob-meta --remote

# 4. (Optional) Pre-set admin password hash or configure Cloudflare Zero Trust Access in worker/wrangler.jsonc
# 5. Deploy Worker, Durable Objects, Static Assets, and */5 Cron Trigger
npm --prefix worker run deploy
```

By default, `worker/wrangler.jsonc` ships with `"workers_dev": true` and `"AUTH_MODE": "builtin"` (first-visit setup wizard at `/api/auth/setup`).

### Option B: GitHub Actions Auto-Deploy (`.github/workflows/deploy-cloudflare.yml`)

Fork the repo and configure **Settings -> Secrets and variables -> Actions** so you never need to commit personal Cloudflare IDs:

| Kind | Name | Required | Description |
| :--- | :--- | :---: | :--- |
| **Secret** | `CLOUDFLARE_API_TOKEN` | Yes | Cloudflare API Token with Workers Scripts, D1, and Workers Routes permissions |
| **Secret / Variable** | `CLOUDFLARE_ACCOUNT_ID` | Yes | Your Cloudflare Account ID |
| **Variable** | `CF_D1_DATABASE_ID` | Yes | UUID of your `uniob-meta` D1 database |
| **Variable** | `ENABLE_CF_AUTO_DEPLOY` | Optional | Set to `true` to deploy a `main` push after CI succeeds for that commit, or after a Release is published (otherwise `workflow_dispatch` only) |
| **Variable** | `CF_CUSTOM_DOMAIN` | Optional | Custom domain hostname (e.g. `monitor.example.com`) |
| **Variable** | `CF_WORKERS_DEV` | Optional | `"true"` or `"false"` (set `"false"` when gating with Zero Trust Access) |
| **Variable** | `CF_AUTH_MODE` | Optional | `"builtin"` (default) or `"cf_access"` |
| **Variable** | `CF_ACCESS_TEAM_DOMAIN` | Optional | Zero Trust team domain (`your-team.cloudflareaccess.com`) |
| **Secret / Variable** | `CF_ACCESS_AUD` | Optional | Access Application Audience (AUD) tag |
| **Variable** | `CF_ACCESS_ALLOWED_EMAILS` | Optional | Comma-separated allowlist emails (e.g. `admin@example.com`) |

Automatic deployments of `main` wait for CI to succeed and check out the same commit. Manual deployment and published Release triggers remain available. When `ENABLE_CF_AUTO_DEPLOY=true`, the Release workflow explicitly dispatches deployment after publishing successfully. Deployment builds the web assets, downloads the latest Release binaries, applies D1 migrations, and deploys the Worker.

---

## Mode 2: Self-Hosted `uniob-hub` + Cloudflare External Watchdog

> For full reverse-proxy (Cloudflare Tunnel / Caddy / Nginx), Watchdog, and migration walkthroughs, see [docs/deploy-self-hosted.md](./docs/deploy-self-hosted.md).

```bash
# Install uniob-hub on a Linux VPS (listens on 127.0.0.1:8787 by default)
curl -fsSL https://raw.githubusercontent.com/Cusnd/UniOB/main/scripts/install-hub.sh.tmpl | sudo bash -s -- \
  --domain https://hub.example.com

# Install while importing an exported bundle & arming Cloudflare Watchdog heartbeats
curl -fsSL https://raw.githubusercontent.com/Cusnd/UniOB/main/scripts/install-hub.sh.tmpl | sudo bash -s -- \
  --domain https://hub.example.com \
  --import-bundle /tmp/uniob-bundle.json \
  --watchdog-url https://monitor.example.com/api/watchdog/ping \
  --watchdog-secret "<your-watchdog-secret>"

# Uninstall completely
curl -fsSL https://raw.githubusercontent.com/Cusnd/UniOB/main/scripts/install-hub.sh.tmpl | sudo bash -s -- --uninstall
```

### Seamless Reversible Live Migration

Inside **Nodes -> Hub Mode & Migration**, UniOB provides two guided workflows:

1. **Ticket-Based Smart Migration (`uobm1_...`)**: Generate a 30-minute one-time ticket (`POST /api/migration/ticket`) on the destination hub, paste it on the source hub (`POST /api/hub/migrate-smart`), optionally run a 1-node canary test, then sync nodes, channels, rules, and monthly traffic ledgers and roll agents over seamlessly with automatic dead-hub fallback.
2. **One-Line Bootstrap Install (`purpose: "install"`)**: Generate a pre-armed `install-hub.sh` command with a single-use pull token (`uob_mpull_...`) and Watchdog credentials; run it on a fresh VPS, verify reachability, and switch the fleet over cleanly.

---

## Cloudflare Zero Trust Access & Bypass Paths

When placing either Cloudflare Workers or a Tunnel-backed `uniob-hub` behind Cloudflare Access (`AUTH_MODE = "cf_access"`), configure **Bypass / Include: Everyone** policies on machine-to-machine endpoints **before** the root admin **Allow** rule (e.g. allowlisting `admin@example.com`), otherwise installers and probes will receive HTTP `302` redirects:

- `<domain>/api/agent/ws`
- `<domain>/install.sh`
- `<domain>/install-hub.sh`
- `<domain>/releases/*`
- `<domain>/api/migration/pull/*` and `<domain>/api/migration/receive`
- `<watchdog-worker-domain>/api/watchdog/ping`

---

## Building, Releases & Agent Installation

### Tagging a Release (`v*`)

Pushing any `v*` tag triggers [.github/workflows/release.yml](./.github/workflows/release.yml) to test Rust crates, bundle `uniob-web-dist.tar.gz`, cross-compile static `musl` binaries (`uniob-agent` verified `<= 2,621,440` bytes and `uniob-hub` for `x86_64` & `aarch64`), compute `SHA256SUMS`, and publish a GitHub Release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

You can also run the Release workflow manually with a tag; leaving the tag empty only builds artifacts. When `ENABLE_CF_AUTO_DEPLOY=true`, successful publication triggers Cloudflare deployment. Regular `main` pushes deploy after CI succeeds for that commit, without requiring a Release.

### Installing `uniob-agent` on a Monitored Linux Server

```bash
curl -fsSL https://monitor.example.com/install.sh | sudo bash -s -- \
  --url wss://monitor.example.com \
  --id nd_xxx \
  --token uob_live_xxx

# Optional flags:
#   --cmdline <sanitized|comm_only|full>   (default: sanitized)
#   --disable-proc                         disable process table collection
#   --repo <owner/repo>                    GitHub Release repo (default: Cusnd/UniOB)
#   --version <tag|latest>                 probe version tag (default: latest)

# Uninstall cleanly
curl -fsSL https://monitor.example.com/install.sh | sudo bash -s -- --uninstall
```

---

## Local Development Scripts

The root `package.json` exposes convenience scripts (`web/` and `worker/` maintain separate `package-lock.json` files without npm workspaces):

```bash
npm --prefix web install
npm --prefix worker install

npm run typecheck       # web + worker TypeScript checks
npm run build:web       # typecheck + Vite build -> web/dist
npm run test:worker     # Vitest + Miniflare Durable Objects & D1 tests
npm run test:agent      # Rust unit tests for uniob-agent
npm run test:hub        # Rust unit + E2E tests for uniob-hub
```

For local full-stack dev:

```bash
npx --prefix worker wrangler d1 migrations apply uniob-meta --local
npm --prefix worker run dev
npm --prefix web run dev
```

## License

[MIT](./LICENSE) © 2026 UniOB Contributors
