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

## Reporting a Vulnerability

Please **do not** disclose security vulnerabilities publicly in GitHub Issues or Pull Requests.

Instead, report security findings privately through **GitHub Security Advisories** ("Report a vulnerability" under the **Security** tab of `Cusnd/UniOB`).

When reporting, please include:

- Affected component (`agent`, `hub`, `worker`, `web`, or install scripts)
- Steps to reproduce or proof-of-concept
- Potential impact and any suggested remediation

We will acknowledge receipt and work on a coordinated fix and release before public disclosure.
