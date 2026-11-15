# Contributing to UniOB

Thank you for your interest in contributing to **UniOB**! Contributions of bug fixes, documentation improvements, tests, and feature enhancements are warmly welcomed.

## Project Layout

UniOB is a polyglot monorepo made up of four main components:

- `agent/` — Lightweight read-only Linux probe (`uniob-agent`, Rust)
- `hub/` — Self-hosted hub server (`uniob-hub`, Rust + Axum + SQLite)
- `worker/` — Cloudflare Workers + Durable Objects + D1 edge hub (TypeScript)
- `web/` — Management SPA built with React, TypeScript, Vite, and Tailwind CSS

> **Note:** The root `package.json` uses helper scripts (`--prefix web` / `--prefix worker`) rather than npm workspaces.

## Prerequisites

- **Node.js 20+** and `npm`
- **Rust stable** (`rustfmt`, `clippy`)
- *(Optional, for Linux static release builds)* `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl` targets

## Local Development & Verification

Install JavaScript dependencies separately for `web/` and `worker/`:

```bash
npm --prefix web ci
npm --prefix worker ci
```

Before opening a pull request, run the full local check suite from the repository root:

```bash
# TypeScript typechecking & frontend production build
npm run typecheck
npm run build:web

# Cloudflare Worker test suite (Miniflare + Vitest)
npm run test:worker

# Rust formatting, Clippy lints, and tests (Agent & Hub)
cargo fmt --manifest-path agent/Cargo.toml --all -- --check
cargo fmt --manifest-path hub/Cargo.toml --all -- --check
cargo clippy --manifest-path agent/Cargo.toml --all-targets -- -D warnings
cargo clippy --manifest-path hub/Cargo.toml --all-targets -- -D warnings
npm run test:agent
npm run test:hub
```

## Coding Guidelines

- **Read-only agent design**: `uniob-agent` must remain strictly read-only on monitored nodes (no remote shell, command execution, or arbitrary file writes) and keep release binary size under the CI budget (`<= 2.5 MB` / `2,621,440` bytes).
- **Formatting & lints**: All Rust code must pass `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings`. All TypeScript code must pass `npm run typecheck`.
- **No sensitive defaults**: Never commit personal Cloudflare `account_id`, D1 `database_id`, email allowlists, bot tokens, secrets, or compiled binaries (`web/public/releases/` is gitignored).
- **Protocol parity**: Changes to the Hub HTTP/WebSocket API or migration bundle schema must stay compatible across `worker/` and `hub/`, and update [docs/API.md](docs/API.md) when public contracts change.

## Pull Request Process

1. Fork the repository and create a topic branch from `main`.
2. Make focused commits with clear messages explaining *why* a change is needed.
3. Add or update unit/integration tests for any new or modified behavior.
4. Ensure all CI checks pass on your PR branch.
