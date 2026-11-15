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
4. **Optional active network probes**: Network quality is disabled by default. Admin-authenticated global/per-node settings enable three TCP/IPv4 targets at a fixed 20-second interval. Probes require outbound DNS and TCP to the configured ports (80 by default), in addition to the telemetry WSS connection. No inbound listener, raw socket, `CAP_NET_RAW`, shell command, or application request body is added. Every resolution is checked against the public IPv4 policy; the validated socket address is passed directly to the connector. Private, loopback, link-local, multicast, unspecified, documentation and benchmark ranges are rejected. DNS proxies that return fake IPs such as `198.18.0.0/15` therefore produce a configuration error. The scheduler has three persistent workers, a bounded queue and separate DNS/connect time budgets; a blocked OS resolver cannot create unbounded replacement threads.

Network failure percentages describe completed TCP/DNS attempts to a specific target; they are not packet-loss measurements. Probe history and optional payloads use bounded independent storage, so malformed optional extensions do not replace resource telemetry. Configuration imports are validated before use, and network history remains outside migration bundles. See the [network quality contract](docs/features/network-quality-contract.md).

## Reporting a Vulnerability

Please **do not** disclose security vulnerabilities publicly in GitHub Issues or Pull Requests.

Instead, report security findings privately through **GitHub Security Advisories** ("Report a vulnerability" under the **Security** tab of `Cusnd/UniOB`).

When reporting, please include:

- Affected component (`agent`, `hub`, `worker`, `web`, or install scripts)
- Steps to reproduce or proof-of-concept
- Potential impact and any suggested remediation

We will acknowledge receipt and work on a coordinated fix and release before public disclosure.
