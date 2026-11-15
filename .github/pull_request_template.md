## Summary

<!-- Describe what this PR changes and why. -->

## Affected Components

- [ ] `agent/` (`uniob-agent`)
- [ ] `hub/` (`uniob-hub`)
- [ ] `worker/` (Cloudflare Workers / D1 / DO)
- [ ] `web/` (Dashboard SPA)
- [ ] `scripts/` / `.github/` / `docs/`

## Verification Checklist

- [ ] `npm run typecheck` passed
- [ ] `npm run build:web` passed
- [ ] `npm run test:worker` passed
- [ ] `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` passed for `agent/` and `hub/`
- [ ] `npm run test:agent` and `npm run test:hub` passed
- [ ] No secrets, personal Cloudflare IDs, emails, or compiled release binaries were committed
- [ ] Relevant documentation (`README*`, `docs/*`) updated if behavior or API changed
