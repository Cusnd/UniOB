# UniOB

[![CI](https://github.com/Cusnd/UniOB/actions/workflows/ci.yml/badge.svg)](https://github.com/Cusnd/UniOB/actions/workflows/ci.yml)
[![Release](https://github.com/Cusnd/UniOB/actions/workflows/release.yml/badge.svg)](https://github.com/Cusnd/UniOB/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

[简体中文](./README.md) | **English**

**Lightweight, read-only monitoring and instant alerting for Linux server fleets** — built to stay effortless even on 512 MB / 1 GB RAM VPS instances.

Run UniOB **serverless on Cloudflare Workers for `$0/month`** without buying a dedicated dashboard server, or **self-host a single static binary (`uniob-hub`)**, and live-migrate your entire fleet between the two in a couple of clicks.

---

## ✨ Why UniOB?

- **🪶 Featherweight Probe for Small VPSes**
  The monitored-node agent is a single `< 2.5 MB` static binary with zero runtime dependencies and **3–6 MB** of RAM usage.
- **🔒 Strictly Read-Only by Design**
  No WebSSH, no remote command execution, and no child shell spawning. Process command lines are automatically sanitized to strip secrets — your monitoring tool can never become a remote execution backdoor.
- **☁️ / 🖥️ Dual Deployment Modes with One-Click Live Migration**
  - **No spare server for a dashboard?** Deploy on **Cloudflare Workers Free**. When no dashboard tab is open, probes automatically shift into low-write batch mode (comfortably running dozens to ~100 servers within the free tier) while still firing **0-second instant alerts** on resource spikes; opening the dashboard immediately restores 1-second live charts.
  - **Want a 24/7 wallboard or full local data ownership?** Install **`uniob-hub`** on any Linux VPS with a single command (no Docker needed, embedded SQLite). Pair it with a free Cloudflare Worker **External Watchdog** so you still get alerted even if the dashboard VPS itself loses power or network.
  - Both modes share the exact same UI and features. Paste a one-time **migration ticket** in the web UI to move all servers, alert rules, and monthly traffic ledgers seamlessly between Cloudflare and self-hosted (with automatic rollback if unreachable).
- **📊 Practical Day-to-Day Fleet Ops**
  - **High-density multi-view dashboard**: Switch between Bento cards (with customizable primary charts: **Live Network / CPU / TCP Latency / Memory**), matrix, and table views.
  - **On-demand process inspector**: Streams top processes only while you are actively viewing a server and stops automatically afterward.
  - **Optional TCP network quality probing**: Track latency and packet/connect failure rates across up to 8 custom targets or built-in regional presets.
  - **Zero-SSH maintenance**: Monthly bandwidth tracking, multi-channel alert notifications, and **one-click agent updates** from the web UI with automatic rollback on failure.

---

## 🧭 Which Deployment Mode Fits You?

| Aspect | ☁️ Cloudflare Workers Edge | 🖥️ Self-Hosted `uniob-hub` |
| :--- | :--- | :--- |
| **Best for** | Small-to-medium fleets without maintaining a panel VPS | Larger fleets, strict local data ownership, or **24/7 live wallboards** |
| **Server required?** | **None** (runs on Cloudflare's global network) | Any Linux VPS (single static binary, ~10–20 MB RAM, monitors localhost automatically) |
| **Ongoing cost** | **Free (`$0/mo`)** on Workers Free for normal viewing; `$5/mo` Paid for huge fleets | **Zero cloud bill** (unlimited local disk writes) |
| **Panel outage protection** | Native Cloudflare edge availability | Optional free **Cloudflare Watchdog** alerts you if your hub goes offline |
| **Step-by-step guide** | 👉 **[Cloudflare Setup Guide (ZH)](./docs/deploy-cloudflare.md)** | 👉 **[Self-Hosted & Migration Guide (ZH)](./docs/deploy-self-hosted.md)** |

> 💡 **Easy to change your mind later**: Start on Cloudflare Free in 10 minutes, and live-migrate to a self-hosted VPS (or back) anytime from the web dashboard.

---

## 🚀 Quick Start

### Option 1: Deploy on Cloudflare Workers (Zero Server)

With `Node.js >= 20` installed locally:

```bash
# 1. Clone and install frontend & worker dependencies
git clone https://github.com/Cusnd/UniOB.git && cd UniOB
npm --prefix web install && npm --prefix worker install
npm run build:web

# 2. Log in to Cloudflare and create a D1 database (paste the output database_id into worker/wrangler.jsonc)
npx --prefix worker wrangler login
npx --prefix worker wrangler d1 create uniob-meta

# 3. Apply remote database migrations
npx --prefix worker wrangler d1 migrations apply uniob-meta --remote

# 4. Deploy
npm --prefix worker run deploy
```

<details>
<summary><b>Deploy via GitHub Actions instead (Fork & configure Secrets/Variables)</b></summary>

Fork this repository and add the following under **Settings -> Secrets and variables -> Actions**, then trigger **Deploy to Cloudflare Workers**:

| Type | Name | Required | Description |
| :--- | :--- | :---: | :--- |
| **Secret** | `CLOUDFLARE_API_TOKEN` | ✅ | API Token with Workers Scripts, D1, and Workers Routes permissions |
| **Secret / Variable** | `CLOUDFLARE_ACCOUNT_ID` | ✅ | Your Cloudflare Account ID |
| **Variable** | `CF_D1_DATABASE_ID` | ✅ | UUID of your `uniob-meta` D1 database |
| **Variable** | `CF_CUSTOM_DOMAIN` | Optional | Custom domain (e.g. `monitor.example.com`) |
| **Variable** | `ENABLE_CF_AUTO_DEPLOY` | Optional | Set `true` to auto-deploy on `main` pushes and Releases |
| **Variable** | `CF_AUTH_MODE` | Optional | `"builtin"` (default password login) or `"cf_access"` |
| **Variable** | `CF_WORKERS_DEV` | Optional | `"true"` / `"false"` (set `"false"` when using Zero Trust Access) |
| **Variable** | `CF_ACCESS_TEAM_DOMAIN` | Optional | Zero Trust team domain (`your-team.cloudflareaccess.com`) |
| **Secret / Variable** | `CF_ACCESS_AUD` | Optional | Zero Trust Application Audience (AUD) tag |
| **Variable** | `CF_ACCESS_ALLOWED_EMAILS` | Optional | Comma-separated admin email allowlist |

</details>

---

### Option 2: Self-Host `uniob-hub` (Single Binary, No Docker)

On any `systemd`-based Linux server (`x86_64` or `aarch64`):

```bash
curl -fsSL https://raw.githubusercontent.com/Cusnd/UniOB/main/scripts/install-hub.sh.tmpl | sudo bash -s -- \
  --domain https://hub.example.com
```

By default, `uniob-hub` listens safely on `127.0.0.1:8787` and automatically monitors the host machine itself. Expose it over HTTPS via Cloudflare Tunnel, Caddy, or Nginx, then open your domain to set up your admin password.

> **Using Cloudflare Zero Trust Access?** Make sure to create **Bypass** rules for machine endpoints (`/api/agent/ws`, `/install.sh`, `/install-hub.sh`, `/releases/*`, `/api/migration/*`, and `/api/watchdog/ping`) before your root `Allow` policy so probes and installers aren't redirected to the login page.

---

### Adding & Managing Monitored Servers

1. **Add a server**: Open the **Servers** tab in your dashboard, create a node, and run the generated one-line `curl` command on your target Linux host.
2. **Manage from the UI**: Toggle TCP network quality probes, upgrade agents across your fleet, or live-migrate hubs directly from the browser — no repeated SSH sessions needed.
3. **Clean uninstall**: Pass `--uninstall` anytime to remove the service and all local files cleanly:

```bash
# Uninstall agent on a monitored server
curl -fsSL https://monitor.example.com/install.sh | sudo bash -s -- --uninstall

# Uninstall self-hosted uniob-hub
curl -fsSL https://raw.githubusercontent.com/Cusnd/UniOB/main/scripts/install-hub.sh.tmpl | sudo bash -s -- --uninstall
```

---

## 📚 Documentation

**Setup & User Guides**
- ☁️ **[Cloudflare Workers Deployment Guide (ZH)](./docs/deploy-cloudflare.md)** — Free-tier capacity, 5-step setup, and Zero Trust Access configuration
- 🖥️ **[Self-Hosted `uniob-hub` & Live Migration Guide (ZH)](./docs/deploy-self-hosted.md)** — Single-binary install, reverse proxies, Watchdog alerts, and live migration
- 🌐 **[Network Quality Probing (ZH)](./docs/features/network-quality.md)** — Custom TCP latency targets, presets, and storage details

**Architecture & Development**
- 🏗️ **[Architecture Deep-Dive (ZH)](./docs/ARCHITECTURE.md)** · 📐 **[Technical Spec & Cost Model (ZH)](./docs/SPEC.md)** · 🔌 **[HTTP & WebSocket API Reference](./docs/API.md)**
- 🤝 **[Contributing & Local Build Guide](./CONTRIBUTING.md)** · 🔒 **[Security Policy](./SECURITY.md)** · 📝 **[Changelog](./CHANGELOG.md)**

## License

[MIT](./LICENSE)
