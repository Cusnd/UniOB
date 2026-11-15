# UniOB API & Wire Protocol Reference

UniOB exposes a unified HTTP REST and WebSocket control-plane interface across both **Cloudflare Edge Hub** (`worker/src/index.ts`) and **Self-Hosted Hub** (`hub/src/routes.rs`).

> Unless marked **Public** or **Signed**, all `/api/*` endpoints require an authenticated admin session (`builtin` HTTP-only session cookie or `cf_access` JWT header `Cf-Access-Jwt-Assertion`).

---

## 1. Health, Auth & Installer Endpoints

| Method | Path | Auth | Availability | Description |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/health` | Public | Worker | Basic Worker health/readiness check |
| `GET` | `/api/auth/me` | Public | Both | Returns current auth state, configured `auth_mode`, and user identity |
| `GET` | `/api/auth/status` | Public | Worker | Returns whether initial admin password setup has been completed |
| `POST` | `/api/auth/setup` | Public | Both | Sets initial admin password (`{ "password": "..." }`) when in `builtin` mode and uninitialized |
| `POST` | `/api/auth/login` | Public | Both | Authenticates `{ "password": "..." }` and sets signed HTTP-only session cookie |
| `POST` | `/api/auth/logout` | Public | Both | Clears admin session cookie |
| `GET` | `/install.sh` | Public | Both | Serves rendered `uniob-agent` installer shell script |
| `GET` | `/install-hub.sh` | Public | Both | Serves rendered `uniob-hub` installer shell script |

---

## 2. Node Management & Time-Series Query

### Endpoints

| Method | Path | Auth | Availability | Description |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/nodes` | Admin | Both | List all nodes with latest metrics, hardware metadata, `caps`, `auto_update_override`, `update_status`, online status, and monthly traffic summary |
| `GET` | `/api/nodes/:id` | Admin | Worker | Fetch summary for a single node |
| `POST` | `/api/nodes` | Admin | Both | Create a node (`name`, optional `group_name`, `tags`, `sort_order`, `traffic_limit_bytes`, `traffic_reset_day`, `traffic_count_mode`); returns plaintext `token` once |
| `PATCH` | `/api/nodes/:id` | Admin | Both | Update node metadata, grouping, tags, sort order, traffic quota settings, `mute_until`, or `auto_update_override` (`boolean \| null`) |
| `POST` | `/api/nodes/:id/rotate-token` | Admin | Both | Rotate agent bearer token and return the new plaintext token once |
| `POST` | `/api/nodes/:id/mute` | Admin | Worker | Convenience endpoint to set or clear alert mute window |
| `DELETE` | `/api/nodes/:id` | Admin | Both | Delete node and clean up associated state |
| `GET` | `/api/nodes/:id/metrics` | Admin | Both | Query ring-slab historical points (`?range=1h\|24h\|7d\|30d\|1y`) |

### `GET /api/nodes/:id/metrics?range=...`

Valid `range` values map automatically to ring-slab resolutions:

| `range` | Resolution | Response Shape |
| :--- | :--- | :--- |
| `1h` / `24h` | `30s` (`metrics_chunk_10m`) | `{ node_id, range, resolution, points }` |
| `7d` / `30d` | `5m` (`metrics_5m_chunk_1h`) | Same |
| `1y` | `1h` (`metrics_1h_chunk_1d`) | Same |

Each element of `points` contains:

```json
{
  "ts": 1760000000,
  "cpu": 18.4,
  "cpu_max": 42.0,
  "steal": 0.2,
  "load1": 0.45,
  "mem_used": 1073741824,
  "mem_max": 1200000000,
  "swap_used": 0,
  "disk_used": 8589934592,
  "disk_r_bps": 4096,
  "disk_w_bps": 16384,
  "net_rx_bps": 102400,
  "net_tx_bps": 204800,
  "tcp_est": 24
}
```

---

## 2.1 Network Quality (optional v1 extension)

Both backends expose these authenticated endpoints:

| Method | Path | Body / result |
| :--- | :--- | :--- |
| `GET` / `PUT` | `/api/network-quality/config` | Global `{enabled, interval_sec?, targets}`; disabled by default |
| `GET` / `PUT` | `/api/nodes/:id/network-quality/config` | `{mode:"inherit"}`, `{mode:"off"}`, or `{mode:"custom",config:{enabled,interval_sec?,targets}}` |
| `GET` | `/api/nodes/:id/network-quality?range=1h&cursor=...` | `{node_id,range,resolution_sec,server_time,state,series,next_cursor}` |

Configs support `1..=8` customizable targets and a global/per-override `interval_sec` in `10..=300` (default `20`). Each target has `{id, enabled, label, region?, host, port, address_family:"ipv4"}`: `id` matches `^[a-z0-9][a-z0-9_-]{0,23}$`, `label` is `1..=32` chars, optional `region` is `<= 64` chars, `host` is a `<= 253` ASCII DNS hostname or public IPv4 literal, and `port` is `1..=65535` (default `80`). Canonical ordering sorts built-in `ct` -> `cu` -> `cm` first, then custom `id`s lexicographically (ASCII). When `interval_sec == 20`, `interval_sec` is omitted from serialized canonical configs and excluded from the `config_id` SHA-256 preimage, preserving v1 golden config hashes. Responses include `config`, normalized `effective_config`, `config_id`, `applied_config_id`, and `supported`. Because saves can precede Agent acknowledgement, clients compare `config_id` against `applied_config_id`.

History ranges `1h`/`24h` return raw attempts at `control.interval_sec ?? 20` resolution (`resolution_sec`, trailing 120-second failure rate over up to 6 attempts per `(target_id, segment_id)`); `7d`/`30d` return 5-minute (`resolution_sec: 300`) per-segment weighted aggregates. All-failure latency is `null` and failure rate is `100`. Missing attempts and changed segments appear as gaps. Invalid ranges (including `1y`) and invalid/expired cursors return `400`; unknown nodes return `404`. Follow every `next_cursor` until `null`; pages are bounded to 3,000 points and 1,000,000 UTF-8 bytes of serialized points. Cursors expire after 30 minutes and pin the query end time.

Agents advertise `network_quality_v1` in `hello.capabilities`. Supporting hubs send `ctrl.network_quality`; omission in the first control stops inherited probing, while omission in later controls means unchanged. Optional `network_quality` data is carried at the top level of existing `m`/`mb` frames (Agent queue caps at 270 points / 128 KiB UTF-8; Worker/Hub parser accepts up to 720 points / 384 KiB), never inside resource tuples or `mb.last`. Failed parsing of this extension leaves existing resource/control fields usable. Raw points are deduplicated by sample identity. Node snapshots contain only compact latest state, without the raw batch. Normal Idle upload cadence remains 300 seconds.

For full target schema, canonical hashing rules, presets, Bento metric display, and storage/DO cost analysis, see [features/network-quality.md](features/network-quality.md). Only configuration is included in export/migration bundles; retained network history stays on its original hub.

---

## 2.2 Agent Auto-Update (`auto_update_v1`)

Both backends expose authenticated endpoints for managing signed remote agent updates:

| Method | Path | Body / Result |
| :--- | :--- | :--- |
| `GET` | `/api/agent-update/config` | Returns `{ ok: true, config, latest_release, bundled_version }` |
| `PUT` | `/api/agent-update/config` | Updates global config (`auto_update_enabled`, `channel`, `check_interval_sec`, `custom_base_url`) and invalidates cached release metadata when source settings change |
| `POST` | `/api/agent-update/check` | Refreshes `latest_release` immediately and returns `{ ok: true, latest_release, checked_at, bundled_version, error }` |
| `POST` | `/api/agent-update/trigger` | Body `{ node_ids?: string[], force?: boolean }`; dispatches signed `ctrl.update` directives and returns `{ ok: true, version, targeted, dispatched, skipped }` |

### Global Config & Release Discovery

- `auto_update_enabled` (`boolean`, default `false`): Automatically pushes signed directives to connected nodes with `auto_update_v1` capability whose `auto_update_override` is `null` (inherit) or `true`.
- `channel` (`"stable" | "github"`, default `"stable"`):
  - `"stable"` checks local `/releases/SHA256SUMS` (and `/releases/VERSION`, defaulting tag/version comment or bundled version `"0.2.0"`), falling back to GitHub Releases (`Cusnd/UniOB` by default) when local binaries are absent.
  - `"github"` queries GitHub `/releases/latest` (resolving digests from GitHub asset `digest` or the release `SHA256SUMS` asset) and attaches a matching local binary `fallback_url` when available.
- `check_interval_sec` (`60..=604800`, default `21600` = 6h): Minimum background polling cadence for automatic checks (`RELEASE_CACHE_TTL_SEC = 900s` on Worker).
- `custom_base_url` (`string | null`, default `""`): When non-empty, overrides `channel` and fetches `${custom_base_url}/SHA256SUMS` (and optional `VERSION`). Rejects non-HTTP(S) URLs, embedded credentials, query strings, fragments, and control characters (Cloudflare Worker also enforces SSRF public-host checks via `worker/src/ssrf.ts`).
- `bundled_version`: Compiled agent/package version bundled with the hub (currently `"0.2.0"`, while Worker control-plane `WORKER_VERSION` is `"2.0.0"`).

### Per-Node Override & Live Status

- `PATCH /api/nodes/:id` accepts `auto_update_override?: boolean | null`:
  - `null`: Inherit global `auto_update_enabled`.
  - `true`: Force enable automatic updates for this node.
  - `false`: Opt this node out of automatic dispatch (still allows explicit `POST /api/agent-update/trigger` when `force: true`).
- Every `NodeSummary` (`GET /api/nodes`, `GET /api/nodes/:id`, `PATCH /api/nodes/:id`) and WS `fleet_batch` / `fleet_tick` payload carries:
  - `caps`: `string[]` (from agent `hello.capabilities`).
  - `auto_update_override`: `boolean | null`.
  - `update_status`: `{ state: "idle" | "downloading" | "staged" | "applying" | "error", target_version?: string, error?: string, updated_at?: number } | null`.
- Migration bundles (`GET /api/export/bundle` / `POST /api/import/bundle`) preserve `agent_update_config` in `system_settings` and `auto_update_override` on nodes, while excluding transient `agent_update_cache`.

---

## 3. Alert Channels, Rules & Incidents

| Method | Path | Auth | Availability | Description |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/alerts/channels` | Admin | Both | List notification channels (`telegram` or `webhook`) |
| `POST` | `/api/alerts/channels` | Admin | Both | Create channel (`name`, `type`, `enabled`, `config`) |
| `PATCH` | `/api/alerts/channels/:id` | Admin | Both | Update channel config or enable/disable state |
| `DELETE` | `/api/alerts/channels/:id` | Admin | Both | Delete notification channel |
| `POST` | `/api/alerts/channels/:id/test` | Admin | Both | Send test notification through the channel |
| `GET` | `/api/alerts/rules` | Admin | Both | List alert rules |
| `POST` | `/api/alerts/rules` | Admin | Both | Create rule (`metric`: `offline \| cpu \| steal \| mem \| swap \| disk \| traffic_pct`, `operator`: `gt \| gte`, `threshold`, `duration_sec`, `cooldown_sec`, `channel_ids`, optional `node_id`) |
| `PATCH` | `/api/alerts/rules/:id` | Admin | Both | Update alert rule |
| `DELETE` | `/api/alerts/rules/:id` | Admin | Both | Delete alert rule |
| `POST` | `/api/alerts/rules/presets` | Admin | Both | Provision baseline alert rule presets |
| `GET` | `/api/alerts/incidents` | Admin | Both | Paginated incident log (supports `node_id`, `status=firing\|resolved`, `limit`, `offset`) |

---

## 4. Hub Status, Watchdog & Seamless Migration

### Endpoints

| Method | Path | Auth | Availability | Description |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/hub/status` | Admin | Both | Returns `{ mode, version, connected_agents, total_nodes, watchdog }` |
| `GET` | `/api/export/bundle` | Admin | Both | Exports portable `ExportBundle` JSON (excludes transient host `watchdog_state` and migration tickets) |
| `POST` | `/api/import/bundle` | Admin | Both | Imports `ExportBundle` into current hub (`nodes`, `notification_channels`, `alert_rules`, `system_settings`, `traffic_ledgers`) |
| `POST` | `/api/migration/ticket` | Admin | Both | Creates short-lived ticket (`TTL = 1800s`) for `"receive"` (`uobm1_...` connection code) or `"install"` (`uob_mpull_...` bootstrap command) |
| `POST` | `/api/hub/migrate` | Admin | Both | Pushes signed `ctrl.migrate` cutover directives to connected agents (`target_url`, optional `fallback_url`, `node_ids`, `allow_insecure_ws`) |
| `POST` | `/api/hub/migrate-smart` | Admin | Both | Accepts target ticket/input (`target_input`), validates & pushes `ExportBundle`, then dispatches agent cutover directives |
| `GET` | `/api/migration/pull/:token` | Token | Both | One-time read pull for `install-hub.sh --bootstrap-bundle` (`Cache-Control: no-store`; also served on `/releases/migration/pull/:token`) |
| `POST` | `/api/migration/receive` | Token | Both | Receives `ExportBundle` authenticated via `Authorization: Bearer <uob_mtk_...>` or `X-Migration-Token` (also served on `/releases/migration/receive`) |
| `GET` | `/api/watchdog/config` | Admin | Worker | Retrieves Cloudflare Watchdog config (`enabled`, `secret`, `timeout_sec`, `cooldown_sec`, `hub_label`, `channel_ids`) and current watchdog status |
| `PUT` | `/api/watchdog/config` | Admin | Worker | Updates Watchdog config or rotates Watchdog HMAC secret (`rotate_secret: true`) |
| `POST` | `/api/watchdog/ping` | HMAC | Worker | Receives signed heartbeat from `uniob-hub` |

### Watchdog Heartbeat Signature (`POST /api/watchdog/ping`)

Self-hosted `uniob-hub` signs the exact request body with the shared Watchdog secret:

- Headers:
  - `X-Watchdog-Timestamp`: Unix epoch seconds (`|now - ts| <= 300s`)
  - `X-Watchdog-Signature`: lowercase hex HMAC-SHA256 over `"${ts}:${rawBody}"`
- JSON Body:

```json
{
  "hub_label": "Self-Hosted UniOB Hub",
  "version": "2.0.0",
  "connected_agents": 12,
  "total_nodes": 12,
  "ts": 1760000000
}
```

---

## 5. WebSocket Protocols

### 5.1 Agent WebSocket (`GET /api/agent/ws`)

- **Authentication**: `Authorization: Bearer <agent_token>` + `X-UniOB-Node-Id: <node_id>` (on upgrade).
- **Agent -> Hub frames**:
  - `t: "hello"`: Handshake (`v: 2`, `agent_ver` e.g. `"0.2.0"`, `hostname`, `os`, `kernel`, `arch`, `cpu_model`, `cpu_cores`, `mem_total`, `swap_total`, `boot_time`, `proc_enabled`, optional `capabilities` including `"mb_v2"`, `"migrate_v1"`, `"network_quality_v1"`, `"auto_update_v1"`, `migrated_epoch`).
  - `t: "m"`: Single live telemetry frame (`ts`, `up`, `cpu`, `mem`, `disks`, `net`, optional `procs`, optional top-level `network_quality`, optional top-level `upd`).
  - `t: "mb"`: SCCH v2 cohort batch frame (`v: 2`, `reason: "cohort" | "edge" | "flush" | "hello"`, `pts: CompactMetricTuple[]`, `last`, optional top-level `network_quality`, optional top-level `upd`).
    - `CompactMetricTuple` (16 numbers): `[ts, up, cpu_all, steal, iowait, load1, mem_used, swap_used, disk_used, disk_r_bps, disk_w_bps, net_rx_bps, net_tx_bps, rx_tot, tx_tot, tcp_est]`.
    - `upd` compact wire report: `{ st: "idle" | "downloading" | "staged" | "applying" | "error", ver?, err?, ts? }` (Hub and Worker also tolerate normalized `state` / `target_version` / `error` / `updated_at` fields when ingesting).
- **Hub -> Agent control frame (`t: "ctrl"`)**:
  - `{ t: "ctrl", mode: 0 | 1 | 2, interval_ms, batch_sec?, top_n, lease_sec, flush_now?, watermarks?, migrate?, network_quality?, update? }`.
  - When `migrate` is present: `{ url, fallback_url?, epoch, sig }`, where `sig = HMAC-SHA256(UTF8(lowercase(token_sha256)), "${node_id}:${epoch}:${url}")`.
  - When `update` is present: `{ version, sha256, url, fallback_url?, issued_at, hmac }`, where `hmac = HMAC-SHA256(UTF8(lowercase(token_sha256)), "agent_update_v1:${node_id}:${version}:${sha256}:${issued_at}:${url}:${fallback_url ?? ""}")`.

### 5.2 Dashboard Client WebSocket (`GET /api/client/ws`)

- **Client -> Hub commands**:
  - `{"op":"ping"}` -> Cloudflare Edge AutoResponse replies `{"t":"pong"}` without waking DO compute.
  - `{"op":"sub_fleet"}` / `{"op":"unsub_fleet"}`: Subscribe/unsubscribe to fleet-wide `fleet_batch` / `fleet_tick` updates.
  - `{"op":"sub_node","nodeId":"<id>","proc":true|false}` / `{"op":"unsub_node"}`: Request 2s high-resolution detail frames (`node_detail`) and optional live process list (`procs`) for one node.
  - `{"op":"renew"}`: Renews the active client lease and, when the watched Agent's last control dispatch is at least 30 seconds old, its 90-second resource lease. Multiple viewers share this throttle. Renewal does not request a flush, resend network configuration or start a network probe.
- **Hub -> Client frames**:
  - `t: "fleet_batch"`: `{ t: "fleet_batch", ticks: FleetTickMessage[] }`
  - `t: "fleet_tick"`: `{ t: "fleet_tick", nodeId, online, last_seen_ts, traffic, metrics, hardware?, caps?, auto_update_override?, update_status? }`
  - `t: "node_detail"`: `{ t: "node_detail", nodeId, online, ts, metrics, procs? }`
  - `t: "node_offline"`: `{ t: "node_offline", nodeId, last_seen_ts }`
  - `t: "alert_change"`: `{ t: "alert_change", activeAlertsCount? }`
