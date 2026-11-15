# UniOB Architecture (v2)

> 本文档记录了 UniOB 从初代架构（Per-node `NodeDO` + `30s` 行写 + `60s` `setAlarm` + `2s` 跨 DO RPC）演进至 **Architecture v2**（**方向 B：SCCH 协同休眠单 DO** + **方向 A：独立 `uniob-hub` 自建中枢与 CF Watchdog 看门狗** + **同构智能迁移协议**）的完整设计决策、工程落地细节与避坑清单。完整 7 维度 Cloudflare 计费精算见 [SPEC.md](SPEC.md)。

---

## 1. v1 基线成本瓶颈复盘（已解决）

在初代实现中（兼容导出保留于 [../worker/src/do/node-do.ts](../worker/src/do/node-do.ts)），单台在线节点每天固定产生 **`13,584–15,127` 行 DO SQLite 写入**：

| 写入来源（v1 `NodeDO`） | 频率与机制 | 单台日写入行数 | 10 台 Idle 日写入 |
| :--- | :--- | ---: | ---: |
| `metrics_raw` 插入 | 每 `30s` 写入 `1` 行（`shouldWriteRaw`） | `2,880` | `28,800` |
| `traffic_state` upsert | 每 `30s` 覆盖 `1` 行独立表记录 | `2,880` | `28,800` |
| `node_meta` upsert | 每 `30s` 更新 `last_seen_ts` 与快照 JSON | `2,880` | `28,800` |
| `metrics_5m` / `metrics_1h` 聚合 | 每 `5m` (`288`) + 每 `1h` (`24`) `GROUP BY` 写入 | `312` | `3,120` |
| 24h / 30d / 365d TTL `DELETE` | 均摊每日过期行清理（`2880 + 288 + 24`） | `3,192` | `31,920` |
| `ctx.storage.setAlarm` | `ALARM_SLACK_MS = 35s`，每 `60s`（Idle）或 `56s`（Live）续期 `1` 次 | `1,440` | `14,400` |
| **合计（Idle 无看盘基线）** | **10 台即突破 Workers Free `100k` 行/日上限（仅能承载 `<= 7` 台）** | **`13,584`** | **`135,840`** |

此外，v1 基线还存在两项隐性账单与配额风险：

1. **高并发跨 DO RPC 放大**：`2h/day` 看盘时每 `2s` 发生 `NodeDO -> FleetHubDO` `pushFleetTick` RPC（`3,600 * N / 日`），`24x7` 墙板模式下 `200` 台每天高达 `965 万` DO 请求、`$60.78/月`。
2. **冷唤醒 D1 规则重读**：`NodeDO` 每次跨越 `10s` 休眠窗冷唤醒后丢失内存 `rulesCache`，导致 `Idle` 下每 `30s` 重读 D1 `alert_rules` 与 `notification_channels`（`200` 台 `345.6 万` 读/日）。

---

## 2. 方向 A：双模中枢架构（`uniob-hub` 自建中枢 + 热迁移 + CF Watchdog）

UniOB 实现 **Self-Hosted Node Hub（自建节点中枢）** 与 **Cloudflare Edge Hub（SCCH 边缘中枢）** 双模完全对等架构，共用一套只读探针（`uniob-agent`）、一套管理面板（`web/`）与一致的 HTTP/WebSocket API（见 [API.md](API.md)）。

### 2.1 独立轻量自建中枢 `uniob-hub`（`hub/`）

> 为严格保证被控探针 `uniob-agent` 静态 `musl` 二进制体积 `<= 2,621,440` 字节（CI 强制校验），中枢角色独立为同一工作区内的 `hub/` crate（`uniob-hub`），避免引入 `axum` / `rusqlite` / `reqwest` 导致探针体积膨胀。

- **同构 Rust HTTP/WS 网关（[../hub/src/routes.rs](../hub/src/routes.rs)）**：基于 `axum` + `tokio-tungstenite` + `tower-http`，完整实现与 Worker 一致的 `/api/*` REST、`/api/client/ws`、`/api/agent/ws`、`/install.sh`、`/install-hub.sh`、`/releases/*` 与内嵌前端静态 SPA 目录托管（`--web-dir` / `--releases-dir`）。
- **本地 SQLite WAL 存储引擎（[../hub/src/db.rs](../hub/src/db.rs)）**：使用同构 `nodes`、`notification_channels`、`alert_rules`、`alert_incidents`、`system_settings`、`traffic_ledgers`、`node_state`、`alert_rule_states` 及环形块表 `metrics_chunk_10m` / `metrics_5m_chunk_1h` / `metrics_1h_chunk_1d`，启用 `PRAGMA journal_mode = WAL; synchronous = NORMAL; busy_timeout = 5000; foreign_keys = ON; temp_store = MEMORY;`，**0 次云端 DO/D1 调用**。
- **本机 `/proc` 零网络 Loopback 自采集（[../hub/src/self_probe.rs](../hub/src/self_probe.rs)）**：中枢所在宿主机可直接作为本地节点（默认 `node_id = "hub-local"`，可配置）写入本地状态与环形 TSDB 块，无需经公网 WSS 绕回。

### 2.2 内置鉴权与 Cloudflare Zero Trust Access 接入（[../hub/src/auth.rs](../hub/src/auth.rs)）

- 默认仅监听 `127.0.0.1:8787`，内置 `Cf-Access-Jwt-Assertion` RS256 JWKS 在线验签、Fail-Closed 与 `CF_ACCESS_ALLOWED_EMAILS` 白名单校验；无 Cloudflare Access 时支持 `AUTH_MODE="builtin"`（PBKDF2-HMAC-SHA256 + HMAC HttpOnly Cookie + 5 次/5 分钟登录限流）。
- 安装脚本模板 [../scripts/install-hub.sh.tmpl](../scripts/install-hub.sh.tmpl) 与 [../worker/src/install-script.ts](../worker/src/install-script.ts) 同步生成 `/etc/uniob-hub/hub.toml`、`/etc/systemd/system/uniob-hub.service`（`StateDirectory=uniob-hub` + `ProtectSystem=strict`），以及解压 `uniob-web-dist.tar.gz` 静态资源。

### 2.3 Cloudflare Workers Free 外部存活看门狗（`worker/src/watchdog.ts` & `hub/src/watchdog.rs`）

- `uniob-hub` 按 `watchdog_interval_sec`（默认 `300s`）向 CF Worker 发送 `POST /api/watchdog/ping`（携带 `X-Watchdog-Timestamp` 与 `X-Watchdog-Signature`：`HMAC-SHA256(secret, "${ts}:${rawBody}")`，防重放窗口 `<= 300s`）。
- CF Worker 注册 `*/5 * * * *` Cron（`triggers.crons`，每日 `288` 次定时检查 + `288` 次 ping = `576` 次 Worker 请求/日，占 Free `100,000` 上限 **`0.58%`**，零 DO 调用），超时即通过既有通知渠道触发与恢复告警。

### 2.4 同构智能迁移协议与零配置装机（`worker/src/migration.ts` & `hub/src/migration.rs` & `agent/src/migrate.rs`）

1. **短效迁移凭据（`POST /api/migration/ticket`）**：
   - `purpose: "receive"`：生成 `uobm1_...` 连接票据（内含目标原点、`endpoint`、`token` 与过期时间，TTL `1800s`），目标端只需在面板粘贴连接串（`POST /api/hub/migrate-smart`），源中枢即自动同步全量 Bundle 并统一下发探针切流，免去手填 URL / 密钥与逐台 SSH。
   - `purpose: "install"`：生成一次性只读拉取令牌（`uob_mpull_...`，TTL `1800s`），同步预武装 Cloudflare 看门狗并返回一行带 `--bootstrap-bundle` 与 Watchdog 凭据的 `install-hub.sh` 安装命令，新 VPS 装好启动即自动完成全量导入、看门狗配对与切流。
2. **安全导出 / 幂等导入（`/api/export/bundle` & `/api/import/bundle`）**：
   - 完整同步 `nodes`（含 `token_sha256` 保留现有密钥免重装）、`notification_channels`、`alert_rules`、`system_settings` 与 `traffic_ledgers`。
   - 导出与导入均严格过滤宿主机本地瞬态键（`watchdog_state`、`imported_bundle_sha256`、`migration_pull_ticket`、`migration_receive_ticket`、`migration_paired_token`），避免状态互相污染。
3. **双阶段金丝雀探针热迁移（`ctrl.migrate`）**：
   - 中枢计算 `HMAC-SHA256(key = UTF8(lowercase(token_sha256)), msg = "${node_id}:${epoch}:${url}")` 随 `ctrl` 帧下发探针（强制拦截 SSRF 私网地址与非测试环境的明文 `ws://`）。
   - 探针校验签名、时间偏差与单调 `epoch` 后保持旧连接不断开，先建新连接等待 `10s` 内确认首个 `ctrl` 帧（Canary 握手）；成功后原子写入 `/var/lib/uniob/endpoint_override.toml` 切换主连接，若新中枢持续失联（`>= 300s` 或 `>= 10` 次重连失败）自动回退 `fallback_url`。

---

## 3. 方向 B：Cloudflare SCCH（Synchronized Cohort Co-Located Hibernation）架构

在保留零运维 Cloudflare 全托管能力的同时，以全局同址 **`FleetHubDO`**（[../worker/src/do/fleet-hub-do.ts](../worker/src/do/fleet-hub-do.ts)）与分块环存引擎（[../worker/src/do/tsdb-slab.ts](../worker/src/do/tsdb-slab.ts)）落地 **6 大核心降本机制**，将 Idle 日写入从 `13,584` 行/节点降至 **`888` 行/节点 + `96` 集群安全闹钟（10 节点实测 `-93.4%`）**：

1. **Co-Located 单 DO 同址架构 (`FleetHubDO`)**：Agent WS 与管理员 Browser WS 同址接入单一 `FleetHubDO("global")`，`Idle / 2h Ops / 24x7` 全工况 **0 跨 DO RPC**，所有节点共享 `1 × 128 MB` DO 内存与单一 `fleet_batch` 广播通道。Legacy `NodeDO` 保留导出以维持 wrangler `v1` migration 兼容。
2. **`setWebSocketAutoResponse` + 紧凑 Attachment (`< 512 B`)**：浏览器 `25s` 应用心跳（`{"op":"ping"}` -> `{"t":"pong"}`）与探针 `20s` RFC 6455 Ping/Pong 均由 Cloudflare 边缘自动应答，**0 次 DO 请求、0 GB-s 唤醒计费**。
3. **UTC 相位锁定 `5m` Cohort 批量帧 (`mb`) + 边缘水位瞬时冲刷**：Idle（`mode = 0`）下探针仅在 **UTC 5 分钟整点 + `[0, 400)` ms 确定性抖动** 唤醒一次中枢发送 `t = "mb"`（`288` 帧/节点/天 = `14.4` DO 请求/节点/天）；若 `EdgeDetector` 命中 `watermarks`（含恢复滞回）、`|Δcpu| >= 35%` 或检测到系统重启，立即发送 `reason = "edge"` 保留危急告警即时响应；管理员查看详情时如尾点滞后 `> 35s`，DO 下发 `flush_now: true` 实时补齐最新点。
4. **Zero-DDL 冷唤醒检查 + Push-Invalidated 本地 D1 镜像**：`FleetHubDO` 冷启动校验 `hub_meta.schema_version >= '2'` 跳过重复建表；`nodes_mirror`、`alert_rules_mirror`、`channels_mirror` 首次从 D1 灌入后仅由管理端写操作经 DO RPC 主动失效推送，**稳态心跳路径 `0` 次 D1 查询**。
5. **Zero-DELETE Ring-Slab 分块环存 + Welford 流式聚合 + 惰性状态合表**：`metrics_chunk_10m`（`144` 槽 × `10m` = `24h`，每点 `76 B` LE）、`metrics_5m_chunk_1h`（`720` 槽 × `1h` = `30d`，每点 `88 B` LE）与 `metrics_1h_chunk_1d`（`366` 槽 × `1d` = `366d`，每点 `88 B` LE）100% 通过 `INSERT OR REPLACE ON (node_id, slot)` 循环覆写，**0 次时序 `DELETE`**、**0 次 `SELECT ... GROUP BY`**；`node_state` 单行合并在线状态、快照、Welford 累加器与月流量账本。
6. **事件驱动断连闹钟 + 4 挡自适应租约 + Page Visibility 生命周期**：无在线节点时调用 `deleteAlarm()`（`0` 闹钟）；有在线探针时仅设 `15m` 安全兜底（`96` 次/集群/天）；仅断连时设精准 `60s` 判定闹钟（对连接中的 `v2 mode = 0` 探针采用 `390s` 宽限防止假离线）。前端 `useFleetSocket.ts` 在标签页可见时每 `50s` 发 `{"op":"renew"}` 续期 `90s` 租约，隐藏或闲置超时立即 `unsub_fleet`。

---

## 4. 已解决的核心工程陷阱 (Resolved Engineering Traps)

1. **`ProtectSystem=strict` 与探针热迁移持久化冲突**：`scripts/install.sh.tmpl` 为 `uniob-agent.service` 配置 `StateDirectory=uniob`（`StateDirectoryMode=0750`，对应 `/var/lib/uniob`），保持 `/etc/uniob` 只读安全边界的同时支持原子写入 `endpoint_override.toml`。
2. **D1 规则热路径风暴与冷唤醒 DDL 开销**：通过 `hub_meta` 版本号门控绕过重复 `CREATE TABLE`，并以 DO 本地 SQLite 镜像替代每次唤醒查询 D1。
3. **热迁移与 Watchdog HMAC 鉴权安全边界**：覆盖 IPv4/IPv6 私网与回环 SSRF 拦截、`AUTH_MODE=cf_access` 禁止明文 `ws://`、`±600s`（迁移）/ `±300s`（Watchdog）时间窗防重放、常量时间 HMAC 比对与 `10s` 金丝雀握手 + 自动回退。
4. **Workers Observability 采样配额控制**：`worker/wrangler.jsonc` 显式关闭 `traces`（`enabled: false`）并将 `logs.head_sampling_rate` 压低至 `0.05`，防止日志/链路追踪突发耗尽账户免费额度。
5. **跨主机迁移 `watchdog_state` 污染**：导出/导入时过滤宿主机专属 `watchdog_state` 与一次性迁移凭据键，防止旧中枢状态覆盖新中枢。
6. **高并发广播节流与增量更新**：`FleetHubDO` 采用 `FLEET_BROADCAST_THROTTLE_MS = 500` 与 `fleet_batch` 批量合并，前端单次更新视图状态避免卡片重渲染风暴。
7. **Mode-0 假离线与安装脚本 SPA 误命中防护**：
   - `FleetHubDO.alarm()` 对仍在连接中的 `v >= 2 && mode === 0` 探针采用 `COHORT_OFFLINE_THRESHOLD_SEC = 390` 避免 5 分钟批期间误判离线；
   - `/install.sh` 与 `/install-hub.sh` 统一配备 `toml_escape` 注入防护、`is_valid_elf`（拦截 Cloudflare SPA `200 OK` HTML 误当作二进制）、`SHA256SUMS` 校验及配置保留升级。

---

## 5. 核心量化对比（10 台典型规模，30 天/月）

> 以下数据由实装代码路径计算并核验（10 / 50 / 200 节点与 3 种负载完整精算见 [SPEC.md](SPEC.md)）：

| 对比维度（10 台规模） | v1 Cloudflare 基线 | 方向 B：SCCH 边缘中枢 | 方向 A：自建 `uniob-hub` + CF 看门狗 |
| :--- | :--- | :--- | :--- |
| **DO SQLite 日写入（Idle）** | `135,840` 行/日 | **`8,976` 行/日（-93.4%）** | **`0` 行/日** |
| **DO SQLite 日写入（2h 运维）** | `138,326` 行/日 | **`13,440` 行/日（-90.3%）** | **`0` 行/日** |
| **DO 月计费请求（2h 运维）** | `1.25M / 月`（`41,805`/日） | **`0.02M / 月`（`618`/日，-98.5%）** | **`0` 次/月** |
| **DO 月计算时长（2h 运维）** | `4.1k GB-s / 月` | **`0.1k GB-s / 月`（-97.5%）** | **`0 GB-s / 月`** |
| **D1 日读写（Idle，Watchdog 开启 cron）** | `0` 写 / `172,800` 读 | `0` 写 / **`576` 读** | `288` 写 / **`1,152` 读** |
| **Workers Free（`100k` 写入/日）可达上限** | ❌ 最多 ~7 台（10 台超限） | ✅ **Idle 可达 ~112 台 / 2h 运维可达 ~75 台** | ✅ **无节点数限制（`O(1)` 消耗）** |
| **月账单预估（10 台 Idle / 2h Ops / 24x7）** | `$5.00` / `$5.04` / `$7.03` | **`$0.00` / `$0.00` / `$0.00`（Free 可运行）** | **`$0.00` / `$0.00` / `$0.00`（Free 看门狗）** |
