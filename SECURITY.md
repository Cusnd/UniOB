# Security Policy

## Architectural Security Principles

UniOB is designed around strict least-privilege boundaries:

1. **Read-only monitoring agent (`uniob-agent`)**: Collects host telemetry from `/proc` and `/sys` without exposing arbitrary command execution, remote shell access, or file modification capabilities.
2. **Short-lived scoped credentials**:
   - Agent ingestion tokens are stored as SHA-256 digests (`token_sha256`) on the Hub.
   - Built-in dashboard auth hashes admin passwords with PBKDF2-SHA256 / Argon2id and uses HTTP-only cookies.
   - Smart Migration (`uobm1_...`) and pull (`uob_mpull_...`) tokens are single-use / short-TTL credentials (`<= 30 minutes`) rather than reusable admin sessions.
   - Remote agent endpoint migration (`ctrl.migrate`) verifies HMAC-SHA256 signatures pinned to the agent's existing token digest and enforces monotonic `epoch` replay protection.
   - Cloudflare external watchdog pings verify `X-Watchdog-Timestamp` and `X-Watchdog-Signature` (`HMAC-SHA256` over `${ts}:${rawBody}`).
3. **Zero-Trust compatible**: Deployments on Cloudflare Workers support Cloudflare Access JWT verification (`AUTH_MODE="cf_access"`).
4. **Optional active network probes (`network_quality_v1`)**: Network quality is disabled by default. Admin-authenticated global/per-node settings enable `1..=8` TCP/IPv4 targets at a configurable `10..=300` second interval (`20s` default). Probes require outbound DNS and TCP to the configured ports (`80` by default), in addition to the telemetry WSS connection. No inbound listener, raw socket, `CAP_NET_RAW`, shell command, or application request body is added. Every resolution is checked against the public IPv4 policy; the validated socket address is passed directly to the connector. Private, loopback, link-local, multicast, unspecified, documentation, and benchmark ranges are rejected; DNS proxies returning fake IPs such as `198.18.0.0/15` therefore fail probe resolution without compromising telemetry. The scheduler uses a dedicated loop plus a lazily grown worker pool capped at `2 * MAX_TARGETS` (`16` threads, `128 KiB` stack each) with bounded queues and separate DNS/connect budgets, preventing blocked OS resolvers from spawning unbounded replacement threads.

   Network failure percentages describe completed TCP/DNS attempts to a specific target; they are not packet-loss measurements. Probe history and optional payloads use bounded independent storage, so malformed optional extensions do not replace resource telemetry. Configuration imports are validated before use, and network history remains outside migration bundles. See the [network quality specification](docs/features/network-quality.md).
5. **Signed, privilege-separated agent auto-update (`auto_update_v1`)**:
   - **Signed directives & replay guard**: Control frames (`ctrl.update`) carry an HMAC-SHA256 signature computed from the node's lowercase `token_sha256` over `"agent_update_v1:${node_id}:${version}:${sha256}:${issued_at}:${url}:${fallback_url}"`. The agent verifies the MAC in constant time, enforces `|now - issued_at| <= 900s` when the system clock is plausible (`>= 1700000000`), and persists monotonic `last_issued_at` in `/var/lib/uniob/update/state.json` to block directive replays.
   - **Artifact & redirect checks**: Downloads use HTTPS/HTTP with a `<= 5` redirect limit, forbid HTTPS-to-HTTP downgrade redirects, reject `gzip` `Content-Encoding`, enforce a `16 MiB` maximum payload size, and verify `\x7fELF` magic plus exact SHA-256 digest before atomic staging (`0644`) into `/var/lib/uniob/update/{uniob-agent.bin,ready.json}`. Custom mirror URLs (`custom_base_url`) reject embedded credentials, query strings, fragments, and control characters, and both `uniob-hub` and Cloudflare Worker (`worker/src/ssrf.ts`) enforce public HTTP(S) host/IP SSRF checks.
   - **Root/unprivileged split under `ProtectSystem=strict`**: `uniob-agent.service` runs as `nobody` with read-only `/usr` and only `/var/lib/uniob` writable, so it cannot overwrite `/usr/local/bin/uniob-agent`. Instead, `uniob-agent-update.path` (`PathChanged=/var/lib/uniob/update/ready.json`) triggers root oneshot `uniob-agent-update.service` (`/usr/local/sbin/uniob-agent-apply-update`), which re-verifies the staged binary and HMAC via `uniob-agent --config /etc/uniob/agent.toml --verify-staged-update`, backs up the running binary to `.prev`, swaps `/usr/local/bin/uniob-agent`, restarts `uniob-agent`, and automatically rolls back `.prev` if the service is not active after 2 seconds.

## Reporting a Vulnerability

Please **do not** disclose security vulnerabilities publicly in GitHub Issues or Pull Requests.

Instead, report security findings privately through **GitHub Security Advisories** ("Report a vulnerability" under the **Security** tab of `Cusnd/UniOB`).

When reporting, please include:

- Affected component (`agent`, `hub`, `worker`, `web`, or install scripts)
- Steps to reproduce or proof-of-concept
- Potential impact and any suggested remediation

We will acknowledge receipt and work on a coordinated fix and release before public disclosure.
