# Changelog

All notable changes to **UniOB** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-11-15

### Added
- **Customizable Network Quality Monitoring (`network_quality_v1`)**: Multi-target TCP latency & loss probing (`1..=8` public IPv4 targets, `10..=300`s interval) with global defaults and per-node overrides, dedicated Ring-Slab storage (`network_quality_chunk_10m` / `5m_chunk_1h`) & cursor-paginated history API, shared SSRF/RFC special-use IPv4 validation across Agent, Hub, Worker, and Web UI, plus `NetworkQualityPanel` and `NetworkQualitySettings`.
- **Signed Agent Auto-Update (`auto_update_v1`)**: End-to-end HMAC-SHA256 signed `ctrl.update` directives with `stable` (`/releases` with GitHub fallback), `github`, and SSRF-validated `custom_base_url` channels, SHA-256 binary verification, `systemd` `.path` atomic cutover & automatic rollback on failed startup, per-node `auto_update_override` policies, migration bundle sync, and `AgentUpdateModal` fleet management UI.
- **Customizable Fleet Bento Primary Metrics**: Configurable 2~3 column Bento primary metric tiles (`cardMetrics`) with improved offline node card handling.

## [0.2.0] - 2026-11-15

### Changed
- **Atelier Light-First SaaS Dashboard (`web/`)**: Replaced the legacy dark-slate Horizon UI with a warm-paper (`#F6F6F3`) + inset crisp white sheet (`#FFFFFF`) SaaS workspace, 92/5/3 neutral-to-accent hierarchy (`cobalt` / `vermilion` / `jade`), Matte Carbon dark mode, mandatory `tabular-nums` alignment, and unclipped responsive topbar & `⌘K` command palette.
- **Pixel-Exact Telemetry Charts & Live Throughput**: Replaced `uPlot` canvas charts and stretched sparklines with lightweight `ResizeObserver` 1:1 SVG `ObservabilityChart` and `Sparkline` primitives featuring cartesian reference grids, binary byte-rate Y-axis scaling, synchronized hover crosshairs, and real-time `↓ RX / ↑ TX` network throughput across fleet cards, matrix tiles, server tables, and the slide-over node inspector.
- **Streamlined Operations, Alerts & Hub Migration**: Simplified server provisioning, single-row visual alert incidents/rules/channels, and the dual-mode Hub Service & Migration studio with accessible native `<dialog>` modals/drawers, keyboard-accessible sortable tables, and non-intrusive bottom-right auto-dismissing floating toasts.

## [0.1.0] - 2026-11-14

Initial public open-source release of UniOB (internal protocol & worker engine v2.0.0).

### Added
- **Read-only Rust Agent (`uniob-agent`)**: Adaptive multi-tier sampling (sleep/normal/detail/proc modes), cohort batch reporting (`mb` frames), watermark edge flushing, non-blocking bounded offline cache, and Linux `musl` static builds (`x86_64` & `aarch64`, `<= 2.5 MB`).
- **Cloudflare Workers Edge Hub (`worker/`)**: Workers + Durable Objects (`FleetHubDO` & `NodeDO`) + D1 architecture engineered for Free-tier cost budgets (SCCH + DO hibernation), supporting built-in auth and Cloudflare Access JWT verification.
- **Self-Hosted Rust Hub (`hub/` / `uniob-hub`)**: Standalone Axum + SQLite server with HTTP/WS API parity, built-in local host self-probe (`hub-local`), Caddy reverse-proxy integration, and automated installer (`install-hub.sh`).
- **Dual-Mode Seamless Hot Migration & Watchdog**:
  - One-click **Smart Migration** (`uobm1_...` connection tickets + `/api/hub/migrate-smart`) and **Zero-Config Migration Install** (`purpose: "install"` + pre-armed Cloudflare watchdog).
  - Signed remote agent cutover (`ctrl.migrate` with monotonic `epoch` + HMAC-SHA256 verification and automatic fallback rollback).
  - Signed self-hosted Hub heartbeat & outage escalation (`POST /api/watchdog/ping` evaluated via Cloudflare Cron Trigger).
- **Dashboard UI (`web/`)**: Fleet overview grid, uPlot telemetry visualizations (CPU/Steal/Load, Memory/Swap, Disk I/O, Network & TCP, Monthly Traffic billing cycle), live Process & Port Explorer, Alert Channels & Rules (Telegram + HMAC-signed Webhook), and Hub Mode & Migration control panel.
- **CI/CD & Documentation**: GitHub Actions workflows (`ci.yml`, `release.yml`, `deploy-cloudflare.yml`), bilingual READMEs, architecture deep-dive, API reference, and step-by-step deployment guides.
