# UniOB (Unified Observability)

[![CI](https://github.com/Cusnd/UniOB/actions/workflows/ci.yml/badge.svg)](https://github.com/Cusnd/UniOB/actions/workflows/ci.yml)
[![Release](https://github.com/Cusnd/UniOB/actions/workflows/release.yml/badge.svg)](https://github.com/Cusnd/UniOB/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**简体中文** | [English](./README.en.md)

面向多台 Linux 服务器（含 1G/2G 小内存 VPS）的安全只读监控、按需进程透视与实时告警系统。支持 **Cloudflare Workers Free 边缘同址部署（SCCH）** 与 **自建 `uniob-hub`（Rust 独立中枢 + CF 外部看门狗）** 双模架构，一套探针与界面无缝热迁移。

---

## 📚 文档导航

| 文档 | 内容说明 |
| :--- | :--- |
| **[☁️ Cloudflare Workers 边缘部署指南](./docs/deploy-cloudflare.md)** | 适合几台到几十台小鸡，零自备服务器跑通 `$0/月` SCCH + Zero Trust |
| **[🖥️ 自部署 `uniob-hub` 与热迁移指南](./docs/deploy-self-hosted.md)** | 适合大机群 / 24x7 看盘，包含 CF Tunnel、Caddy/Nginx、云端看门狗与无感搬家 |
| **[🏗️ 架构演进与实现细节](./docs/ARCHITECTURE.md)** | v1 成本瓶颈复盘、SCCH 6 大降本机制、智能迁移协议与工程避坑清单 |
| **[🔌 HTTP / WebSocket API 文档](./docs/API.md)** | 全量 REST 接口、Watchdog HMAC 心跳签名与 Agent/Client WS 线协议参考 |
| **[📐 技术规范与 7 维度计费精算](./docs/SPEC.md)** | 数据结构、环形 TSDB 设计、自动更新协议及 10 / 50 / 200 节点 7 维度成本核算 |
| **[🌐 网络质量检测](./docs/features/network-quality.md)** | 可选 1~8 路公网 IPv4 TCP 探测、预设与节点自定义、历史分页与架构约束 |
| **[🤝 贡献指南](./CONTRIBUTING.md) · [🔒 安全策略](./SECURITY.md) · [📝 更新日志](./CHANGELOG.md)** | 本地构建校验、只读安全边界与版本发布说明 |

---

## 架构概览 (Architecture v2)

UniOB 提供 **「方向 B：Cloudflare SCCH 协同休眠边缘中枢」** 与 **「方向 A：独立 `uniob-hub` 自建中枢 + Cloudflare Watchdog 云端掉线提醒」** 两种对等运行模式：

- **`agent/` (`uniob-agent`)**：Rust 编写的纯静态 `musl` 探针，直读 `/proc` 与 `statvfs`，严禁 `fork/exec` 子进程；静态二进制体积严格限制 `<= 2,621,440` 字节（`<= 2.5 MB`，CI 强制校验），常驻内存约 `3–6 MB`；出站 `WSS (443)` 上报，启用网络质量或自动更新时按需出站 DNS / TCP 80（可配置端口）与 HTTPS/HTTP 下载连接，内置：
  - **可选自定义 TCP 延迟探测（`network_quality_v1`）**：默认关闭；管理员可在 **「服务器」->「网络检测」** 配置全局规则，或在单节点编辑中继承、自定义或关闭。支持 **`1..=8` 个公网 IPv4 TCP 目标**、`10..=300` 秒可调间隔（默认 `20s`，`20s` 时省略该字段以保持 v1 `config_id` 哈希兼容）与 3 套预设，提供 TCP 建连耗时、120 秒成功中位数与失败率；原始历史保留 24 小时、5 分钟聚合保留 30 天，Idle 仍随原有 5 分钟批次上报（详见 [网络质量检测指南](./docs/features/network-quality.md)）。
  - **签名节点自动更新（`auto_update_v1`, `agent/src/update.rs`）**：校验中枢 `ctrl.update` 携带的 `HMAC-SHA256(lowercase(token_sha256), "agent_update_v1:...")` 签名、`|now - issued_at| <= 900s` 时钟窗及持久化单调 `issued_at` 防重放；通过零依赖 `rustls` 下载并验证无降级重定向（`<= 5` 跳）、禁止 `gzip`、体积 `<= 16 MiB`、`\x7fELF` 魔数与 `SHA-256`，暂存至 `/var/lib/uniob/update/` 后由 `uniob-agent-update.path` 唤醒 root 助手（`--verify-staged-update`）备份 `.prev` 并原子切换，2 秒后若服务未恢复活跃则自动回滚。
  - **Protocol v2 批量与边缘即时告警**：Idle (`mode = 0`) 下维持 12 槽位 16 元紧凑数组（`CompactMetricTuple`），每 `5` 分钟按 UTC 整点 + `[0, 400)` ms 确定性抖动发送一次 `mb` 批帧；触发 `watermarks` 水位线（含 3% 滞回）、`|Δcpu| >= 35%` 或重启时立即冲刷，保持 `0s` 危急告警响应延迟。
  - **双阶段金丝雀热迁移（`agent/src/migrate.rs`）**：校验中心端下发的 HMAC-SHA256 `migrate` 指令、时间戳窗口与防重放单调 `epoch` 及 SSRF 私网防护；先建新连接等待 `10s` 内首帧 `ctrl` 确认后再原子切换，配置持久化在 `/var/lib/uniob/endpoint_override.toml`（systemd `StateDirectory=uniob`），新中枢连续失联（`>= 300s` 或 `>= 10` 次重试）自动回退 `fallback_url`。
  - **只读进程安全边界**：仅支持固定枚举采样挡位（`0`/`1`/`2`）、可配置无正则词法 `cmdline` 脱敏与 `90s` 租约自动降级。
- **`worker/` (`uniob-worker`)**：基于 Hono、Cloudflare D1、SQLite Durable Objects 与 WebSocket Hibernation API 构建：
  - **SCCH 同址单 DO (`FleetHubDO`)**：将 Agent WebSocket 与管理员 Browser WebSocket 同址收敛于全局单例 `FleetHubDO("global")`（**0 跨 DO RPC**、**1 × 128 MB** 实例计量），通过 `setWebSocketAutoResponse` 在边缘免费应答浏览器 `{"op":"ping"}`，以 `hub_meta.schema_version` 门控免冷唤醒 DDL，以本地 D1 镜像实现 **0 热路径 D1 查询**，并以零 `DELETE` 环形分块 TSDB（`metrics_chunk_10m` / `metrics_5m_chunk_1h` / `metrics_1h_chunk_1d`）+ Welford 在线聚合 + 事件驱动 `60s`/`15m` 闹钟，使 **Workers Free（`100k` 行写/日）可承载高达 ~112 台 Idle 或 ~75 台 2h/日运维节点**（开启 3 目标默认网络探测时 Idle 约 ~52 台）。（兼容性保留 `NodeDO` 导出以维持 `v1` migration。）
  - **Cloudflare Watchdog（`worker/src/watchdog.ts`）**：`*/5 * * * *` Cron 巡检与 HMAC-SHA256 签名心跳接口 `POST /api/watchdog/ping`（Free 仅占 `576` 次 Worker 请求/日）。
  - **D1 (`uniob-meta`)**：存储节点注册表（含 `auto_update_override`）、通知渠道、告警规则、告警事件历史与系统配置（包含 `watchdog_config`/`watchdog_state`、`network_quality_config` 与 `agent_update_config`）。
- **`hub/` (`uniob-hub`)**：方向 A 独立自建 Rust 中枢二进制，使用本地 **SQLite WAL** 与零云端费用同构存储引擎：
  - 与 Worker 对等的 `/api/*`、`GET /api/agent/ws`、`GET /api/client/ws`、`/install.sh`、`/install-hub.sh` 及 `/releases/*`；托管静态前端 `web/dist`。
  - 内置宿主机 `/proc` Loopback 零网络采集（`hub/src/self_probe.rs`，默认节点 ID `hub-local`）及与 Worker 对等的 `auto_update_v1` 发布检查/签发模块（`hub/src/agent_update.rs`）。
  - 支持 **Cloudflare Tunnel + Zero Trust Access（RS256 JWKS）** 与 **内置 PBKDF2 密码会话** 双模鉴权，以及定时向 CF Watchdog 发送签名存活心跳（`hub/src/watchdog.rs`）。
- **`web/` (`uniob-web`)**：基于 React 19 + TypeScript + Vite + TailwindCSS v4 构建 Atelier 浅色高密工作台，内置原生 SVG 实时图表（`ObservabilityChart` / `Sparkline`，`ui/Primitives.tsx`，无 `uPlot` 依赖）；`useFleetSocket.ts` 接入 `document.visibilityState`、路由切换与 `IDLE_TIMEOUT_MS = 10 min` 自动发 `unsub_fleet` 节省配额；支持大盘 Bento 卡片（`FleetBentoGrid.tsx` + `cardMetrics.ts`，顶栏可持久切换主图指标 `实时网络 / CPU / TCP 延迟 / 内存`，离线卡片呈现灰线占位与“离线”徽章）/ 矩阵 / 列表三视图；**「服务器」**（`NodesOpsView.tsx`）内置 **「网络检测」**（`NetworkQualitySettings.tsx`）与 **「自动更新」**（`AgentUpdateModal.tsx`，含单节点策略覆盖及详情页 `HardwareSecurityPanel.tsx` 版本状态展示）；**「服务与迁移」**（`HubMigrationStudio.tsx`）提供口令一键搬家、一键安装新面板并切换、实时迁移进度追踪、**「自建面板掉线提醒」**与**「备份与恢复」**。
- **`scripts/` & `.github/workflows/`**：提供被控端 `install.sh.tmpl`（含 `StateDirectory=uniob` 与 root `uniob-agent-update.path` 自动更新切换单元）与自建中枢 `install-hub.sh.tmpl` 加固脚本，以及持续集成（`ci.yml`）、双架构静态发布（`release.yml`）与可选 Cloudflare 自动部署（`deploy-cloudflare.yml`）工作流。

### 目录结构

```text
UniOB/
├── shared/                 # Agent 与 Hub 共享 TCP 探测调度器、SSRF 策略与基准测试夹具
├── agent/                  # Rust Linux 极轻静态探针 (uniob-agent)
│   └── src/                # collector/, crypto.rs, migrate.rs, update.rs, protocol.rs, sanitize.rs, main.rs
├── hub/                    # Rust 独立自建中枢 (uniob-hub，方向 A)
│   ├── src/                # config.rs, db.rs, agent_update.rs, network_quality_store.rs, auth.rs, routes.rs, hub_state.rs, self_probe.rs, watchdog.rs...
│   └── tests/e2e.rs        # 端到端集成测试
├── worker/                 # Cloudflare Workers + D1 + SCCH Durable Objects 中心端
│   ├── migrations/         # D1 数据库迁移 (0001_init.sql, 0002_auto_update.sql)
│   ├── wrangler.jsonc      # 脱敏 Worker / Assets / D1 / DO / Cron / Observability 配置模板
│   ├── src/                # index.ts, auth.ts, ssrf.ts, auto-update.ts, network-quality.ts, migration.ts, watchdog.ts, do/{fleet-hub-do.ts,tsdb-slab.ts,network-quality-store.ts,node-do.ts}
│   └── test/               # Vitest 单元测试与 DO 集成测试
├── web/                    # React 19 + TailwindCSS v4 + Atelier 原生 SVG 前端面板
│   └── src/                # hooks/{useFleetSocket,useHorizonPrefs}.ts, utils/{cardMetrics,autoUpdate,networkQuality}.ts, components/{FleetOverviewPage,FleetBentoGrid,NodesOpsView,AgentUpdateModal,HubMigrationStudio,NetworkQualityPanel}...
├── scripts/
│   ├── install.sh.tmpl     # Linux 探针 systemd 一键安装/升级/卸载模板 (含 StateDirectory=uniob 与 update path unit)
│   └── install-hub.sh.tmpl # Linux 自建中枢 uniob-hub 一键安装/迁移/卸载模板
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                  # Web 构建 + Worker 测试 + Rust Fmt/Clippy/Tests + 安装脚本语法检查
│   │   ├── release.yml             # Web 打包 + Agent & Hub 双架构 musl 静态二进制交叉编译发布
│   │   └── deploy-cloudflare.yml   # 可选 GitHub Actions 自动化部署至 Cloudflare Workers
│   ├── ISSUE_TEMPLATE/
│   └── pull_request_template.md
├── docs/
│   ├── deploy-cloudflare.md        # Cloudflare Workers 边缘中枢从零部署完整教程（人话版）
│   ├── deploy-self-hosted.md       # 自部署 uniob-hub + CF 看门狗与无感热迁移完整教程（人话版）
│   ├── features/network-quality.md # 可选 1~8 路 TCP 探测、Bento 主指标与存储配额规范
│   ├── ARCHITECTURE.md             # Architecture v2 演进记录、智能迁移协议与工程避坑清单
│   ├── API.md                      # HTTP REST 与 WebSocket 协议参考
│   └── SPEC.md                     # v2 完整技术规范与 7 维度计费精算
├── CONTRIBUTING.md / SECURITY.md / CHANGELOG.md / LICENSE
└── package.json               # 根目录快捷脚本（不使用 npm workspaces）
```

---

## 部署模式一：Cloudflare 边缘中枢 (SCCH，Free / Paid 通用)

> 📖 **新手手把手完整避坑指南（含 Zero Trust Access 5 条 Bypass 路径详解）**：请直接阅读 **[./docs/deploy-cloudflare.md](./docs/deploy-cloudflare.md)**。

> **前置条件**：
> - **Workers Free** 即可运行小中规模机群（默认关闭网络探测时，SCCH 实测 `100k` DO SQLite 写入/日上限可承载 **Idle ~112 台 / 2h 运维 ~75 台 / 24x7 墙板 ~16 台**，7 维度全面在免费额度内；开启 3 目标网络探测后 Idle 约可承载 **~52 台**）。
> - 若机群超过上述阈值（如 200 台），开通 **Cloudflare Workers Paid**（`$5/月` 基础费）即可承载，200 台 24x7 墙板预估仅约 `$5.24/月`。
> - 也可使用[自建 `uniob-hub`](./docs/deploy-self-hosted.md) 承载更大规模与全天候高频看盘（零云端存储/计算费用）。
> - 本地依赖 Node.js（建议 `>= 20`）与 `npm`。

### 方式 1：本地 CLI 手动部署

1. **安装依赖并构建前端 Static Assets（`web/dist`）**：

   ```bash
   npm --prefix web install
   npm --prefix worker install
   npm run build:web
   ```

2. **创建 Cloudflare D1 数据库**：

   ```bash
   npx --prefix worker wrangler d1 create uniob-meta
   ```

   将命令输出的 `database_id` 替换 `worker/wrangler.jsonc` 中的占位 UUID（`00000000-0000-0000-0000-000000000000`）。

3. **执行远程 D1 Schema 迁移**：

   ```bash
   npx --prefix worker wrangler d1 migrations apply uniob-meta --remote
   ```

4. **配置管理员鉴权（默认 `AUTH_MODE = "builtin"` 开箱即用）**：

   详见下方[管理员鉴权配置与 Cloudflare Access Bypass](#管理员鉴权配置与-cloudflare-access-bypass)章节。

5. **部署 Worker + Durable Objects + Static Assets + Watchdog Cron**：

   ```bash
   npm --prefix worker run deploy
   ```

   部署完成后访问分配的 `*.workers.dev` 或自定义域名即可进入 UniOB 面板。`worker/wrangler.jsonc` 已内置 `triggers.crons: ["*/5 * * * *"]` 与轻量可观测采样（`traces.enabled: false`，`logs.head_sampling_rate: 0.05`）。

### 方式 2：通过 GitHub Actions 自动部署（`.github/workflows/deploy-cloudflare.yml`）

Fork 本仓库后，可在 GitHub 仓库的 **Settings -> Secrets and variables -> Actions** 配置以下参数，无需在仓库中硬编码个人 ID。部署工作流会构建前端、下载最新 Release 探针、执行 D1 数据库迁移并部署至 Cloudflare Workers：

| 类型 | 名称 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| **Secret** | `CLOUDFLARE_API_TOKEN` | ✅ | 拥有 Workers Scripts、D1、Workers Routes 权限的 Cloudflare API Token |
| **Secret / Variable** | `CLOUDFLARE_ACCOUNT_ID` | ✅ | 您的 Cloudflare Account ID |
| **Variable** | `CF_D1_DATABASE_ID` | ✅ | 已创建的 `uniob-meta` D1 数据库 UUID |
| **Variable** | `ENABLE_CF_AUTO_DEPLOY` | 可选 | 设为 `true` 时，在 `main` 推送的 CI 成功后部署该提交，或在 Release 发布后部署（默认仅允许手动 `workflow_dispatch`） |
| **Variable** | `CF_CUSTOM_DOMAIN` | 可选 | 自定义域名（如 `monitor.example.com`） |
| **Variable** | `CF_WORKERS_DEV` | 可选 | `"true"` / `"false"`（配合 Zero Trust 时建议设为 `"false"`） |
| **Variable** | `CF_AUTH_MODE` | 可选 | `"builtin"`（默认）或 `"cf_access"` |
| **Variable** | `CF_ACCESS_TEAM_DOMAIN` | 可选 | Zero Trust Team 域名（如 `your-team.cloudflareaccess.com`） |
| **Secret / Variable** | `CF_ACCESS_AUD` | 可选 | Cloudflare Access Application Audience (AUD) Tag |
| **Variable** | `CF_ACCESS_ALLOWED_EMAILS` | 可选 | 允许访问的邮箱列表（英文逗号分隔，如 `admin@example.com`） |

自动部署 `main` 时，工作流等待 CI 成功并检出同一提交。手动部署和 Release 发布触发仍可使用；当 `ENABLE_CF_AUTO_DEPLOY=true` 时，仓库的 Release 工作流会在发布成功后主动触发部署。

---

## 部署模式二：自建节点中枢 (`uniob-hub` + CF 外部看门狗)

> 📖 **新手手把手完整避坑指南（含 CF Tunnel / Caddy / Nginx 反代、云端掉线提醒与无感热迁移）**：请直接阅读 **[./docs/deploy-self-hosted.md](./docs/deploy-self-hosted.md)**。

当您已有一台长期在线的 VPS，或机群规模极大（如 200+ 台 24x7 看盘）希望将高频采集完全留在本地、**Cloudflare 云端账单保持 `$0.00/月`** 时，可直接一键部署 `uniob-hub`。

### 1. 一键安装与启动（`install-hub.sh`）

可通过任意已部署的 Worker 或 GitHub 仓库脚本在目标 Linux 服务器运行：

```bash
# 全新安装自建中枢（默认监听 127.0.0.1:8787，自动拉取 web/dist 与探针缓存）
curl -fsSL https://raw.githubusercontent.com/Cusnd/UniOB/main/scripts/install-hub.sh.tmpl | sudo bash -s -- \
  --domain https://hub.example.com

# 从 Cloudflare / 旧中枢平滑迁入完整状态（保留全部节点 ID 与 Token 哈希）
curl -fsSL https://raw.githubusercontent.com/Cusnd/UniOB/main/scripts/install-hub.sh.tmpl | sudo bash -s -- \
  --domain https://hub.example.com \
  --import-bundle /tmp/uniob-bundle.json \
  --watchdog-url https://monitor.example.com/api/watchdog/ping \
  --watchdog-secret "<your-watchdog-secret>"

# 彻底卸载
curl -fsSL https://raw.githubusercontent.com/Cusnd/UniOB/main/scripts/install-hub.sh.tmpl | sudo bash -s -- --uninstall
```

常见安装落盘路径与 `systemd` 沙箱：
- 二进制：`/usr/local/bin/uniob-hub`
- 配置文件：`/etc/uniob-hub/hub.toml`（包含 `[server]`、`[auth]`、`[self_probe]`、`[watchdog]`）
- 数据库（SQLite WAL）：`/var/lib/uniob-hub/uniob.db`（通过 `StateDirectory=uniob-hub` 授权）
- 前端与探针静态目录：`/usr/local/share/uniob-hub/{web,releases}`

若手动从命令行启动或执行一次性状态导入：

```bash
# 仅幂等导入 Bundle 并退出（基于 imported_bundle_sha256 去重）
uniob-hub --config /etc/uniob-hub/hub.toml --db /var/lib/uniob-hub/uniob.db \
  --import-bundle /tmp/uniob-bundle.json --import-only

# 指定额外覆盖参数运行
uniob-hub --listen 127.0.0.1:8787 --public-url https://hub.example.com \
  --watchdog-url https://monitor.example.com/api/watchdog/ping \
  --watchdog-secret "<your-watchdog-secret>"
```

### 2. 无缝热迁移流程（Cloudflare 云端 ↔ 自建服务器双向可逆）

在面板进入 **「服务器管理」->「面板迁移与运行模式」**，可通过引导式两步向导完成零断线迁移：

- **方式 A：已有目标面板（迁移口令一键搬家）**
  1. 在**新面板**打开 **「面板迁移与运行模式」->「迁入到此面板」**，点击 **「生成迁移口令」**（调用 `POST /api/migration/ticket`，生成 30 分钟有效的 `uobm1_...` 口令并开始等待服务器连入）。
  2. 在**旧面板**切换到 **「迁往其他面板」**，选择 **「已有目标面板（用迁移口令一键搬家）」**，粘贴 `uobm1_...` 口令（可选勾选「先用 1 台在线服务器试路，确认无误后再全部切换」），点击 **「一键同步并切换」**（调用 `POST /api/hub/migrate-smart` 自动同步服务器列表、通知渠道、告警规则、月度流量统计并下发平滑切换指令；各服务器先与新面板完成连接确认后再切流，若新面板异常 1 分钟内自动切回）。
- **方式 B：新装一台自建服务器并搬过去**
  1. 在**旧面板**进入 **「面板迁移与运行模式」->「迁往其他面板」**，选择 **「新装一台自建服务器并搬过去」**，点击 **「生成一键安装命令」**（`POST /api/migration/ticket`，可自动开启 Cloudflare 云端 **「自建面板掉线提醒」** 并附带心跳参数），在目标机器执行生成的 `curl ...` 命令。
  2. 安装完成后填入新面板网址（如 `https://hub.example.com`），点击 **「检测新面板并切换」**，在实时进度条中查看服务器迁移情况并点击 **「打开新面板」**。
- **（可选）云端「自建面板掉线提醒」**：在 Cloudflare 云端面板的 **「面板迁移与运行模式」** 中开启提醒并选择失联判定时间（默认 **15 分钟** / `900s`）与通知渠道；Cloudflare 边缘 Cron（`*/5 * * * *`）会在自建面板断电或失联超时后自动代发告警（手动备份与离线恢复位于折叠区 **「备份与恢复」**）。

---

## 管理员鉴权配置与 Cloudflare Access Bypass

UniOB（Cloudflare Worker 与 `uniob-hub` 均完整支持）提供内置密码认证与 Cloudflare Access 零信任认证两种模式：

### 1. 首次访问初始化设置（默认开箱即用）

若未配置 `ADMIN_PASSWORD_HASH`（或在 `hub.toml` 配置 `[auth] mode = "builtin"`）且未启用 Cloudflare Access，首次打开面板会进入管理员初始化页面（`POST /api/auth/setup`）。内置密码采用 PBKDF2-HMAC-SHA256 哈希与 HMAC-SHA256 签名的 `uniob_session` Cookie（`HttpOnly; SameSite=Strict`，HTTPS 下自动启用 `Secure`，有效期 7 天；登录失败连续 5 次/5 分钟触发 IP 限流 `429`）。

### 2. 通过 `ADMIN_PASSWORD_HASH` 预设管理员密码

```bash
# 计算管理员密码的 SHA-256 十六进制摘要（Worker 与 uniob-hub 均兼容）
printf '%s' 'your-strong-admin-password' | sha256sum | awk '{print $1}'

# Worker 环境写入 Secret
npx --prefix worker wrangler secret put ADMIN_PASSWORD_HASH
```

### 3. Cloudflare Zero Trust Access 生产环境接入（与 CF Tunnel 通用）

生产环境推荐结合 **Cloudflare Zero Trust Access**（Free 免费支持最多 **50 名用户**，免费提供邮箱 **One-time PIN** 登录）与后端双层邮箱白名单纵深防御。当使用 **Cloudflare Tunnel**（`cloudflared` 反代 `http://127.0.0.1:8787`）或 **Workers 自定义域名** 时，请按以下顺序配置：

1. **绑定自定义域名（Workers 部署需禁用 `workers_dev`）**：
   - 在 `worker/wrangler.jsonc` 启用 `"workers_dev": false` 防止绕过 Access。
2. **必须优先配置机器接口与安装资源的 `Bypass` 放行策略（重要！）**：
   - 若整站被 Access 拦截，探针 WSS 握手、一键安装脚本、自建二进制缓存、迁移拉取/接收端点与看门狗心跳会被边缘重定向返回 `302`！请在 **Zero Trust -> Access -> Applications** 中以下述路径创建 **Action: Bypass / Include: Everyone**（路径最长匹配优先）：
     - `<domain>/api/agent/ws`（探针 WebSocket 接入，走 Worker/Hub Bearer SHA-256 鉴权）
     - `<domain>/install.sh`（被控探针一键安装脚本）
     - `<domain>/install-hub.sh`（自建中枢一键安装脚本）
     - `<domain>/releases/*`（自建中枢托管的预编译静态二进制分发与迁移兼容路径）
     - `<domain>/api/migration/pull/*` 与 `<domain>/api/migration/receive`（短效签名迁移凭据端点，如使用热迁移建议一同放行）
     - `<watchdog-worker-domain>/api/watchdog/ping`（CF Watchdog 存活心跳接收接口，走 HMAC-SHA256 + 300s 防重放鉴权）
   - 部署后可用 `curl -I https://monitor.example.com/install.sh` 确认返回 `200 OK`（而非 `302` 跳转）。
3. **创建管理控制台 `Allow` 策略**：
   - 覆盖根路径 `<domain>`：Policy Action = **Allow**，Include Emails = 您的管理员邮箱（如 `admin@example.com`）。
   - 复制应用的 **Team Domain** 与 **Application Audience (AUD) Tag**。
4. **写入配置**：
   - **Cloudflare Worker (`worker/wrangler.jsonc`)**：
     ```jsonc
     "workers_dev": false,
     "vars": {
       "AUTH_MODE": "cf_access",
       "CF_ACCESS_TEAM_DOMAIN": "your-team.cloudflareaccess.com",
       "CF_ACCESS_AUD": "<your-application-audience-tag>",
       "CF_ACCESS_ALLOWED_EMAILS": "admin@example.com"
     }
     ```
   - **自建中枢 (`/etc/uniob-hub/hub.toml`)**：
     ```toml
     [auth]
     mode = "cf_access"
     cf_access_team_domain = "your-team.cloudflareaccess.com"
     cf_access_aud = "<your-application-audience-tag>"
     cf_access_allowed_emails = ["admin@example.com"]
     ```
   - Worker 与 `uniob-hub` 在 `cf_access` 模式下均采取 **Fail-Closed** 策略校验 `Cf-Access-Jwt-Assertion` RS256 JWKS 签名并再次核对白名单邮箱，禁止内置登录。

---

## Rust `musl` 二进制编译与探针安装

### 1. 本地编译与单元测试

```bash
# 分别运行探针 / 中枢单元测试
npm run test:agent
npm run test:hub

# 编译当前平台 Release 版本
npm run build:agent
npm run build:hub
```

### 2. 交叉编译 Linux 纯静态 `musl` 二进制

通过 `cargo-zigbuild` + `zig`（`0.13.0`）交叉编译零 `glibc` 运行时依赖的双架构 `musl` 静态二进制：

```bash
rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl
cargo zigbuild --manifest-path agent/Cargo.toml --release --target x86_64-unknown-linux-musl
cargo zigbuild --manifest-path agent/Cargo.toml --release --target aarch64-unknown-linux-musl
cargo zigbuild --manifest-path hub/Cargo.toml --release --target x86_64-unknown-linux-musl
cargo zigbuild --manifest-path hub/Cargo.toml --release --target aarch64-unknown-linux-musl
```

### 3. GitHub Actions CI/CD 与自动发布

- **持续集成（[.github/workflows/ci.yml](.github/workflows/ci.yml)）**：每次推送 `main` 或发起 PR 时自动校验 `scripts/*.tmpl` shell 语法、前后端 TypeScript 类型检查、`web/dist` 构建、Worker Miniflare 测试，以及 `agent` / `hub` 的 `cargo fmt --check`、`cargo clippy -D warnings` 与单元测试/E2E。
- **自动发布（[.github/workflows/release.yml](.github/workflows/release.yml)）**：推送 `v*` 标签或手动运行时填写 tag，即构建并发布 GitHub Release 产物；手动运行未填写 tag 时仅生成构建产物：

```bash
git tag v0.2.0
git push origin v0.2.0
```

工作流自动运行 `agent` 与 `hub` 测试，构建前端产物 `uniob-web-dist.tar.gz`，交叉编译 `uniob-agent-{x86_64,aarch64}-unknown-linux-musl`（强制校验 `<= 2,621,440` 字节）与 `uniob-hub-{x86_64,aarch64}-unknown-linux-musl`，并生成 `SHA256SUMS` 一并发布。

启用 `ENABLE_CF_AUTO_DEPLOY` 后，发布成功会继续触发 Cloudflare 部署。日常推送 `main` 则等待该提交的 CI 成功后自动部署，无需创建 Release。

### 4. Linux 被控节点一键安装 / 升级 / 卸载

```bash
# 全新安装或覆盖升级
curl -fsSL https://monitor.example.com/install.sh | sudo bash -s -- \
  --url wss://monitor.example.com \
  --id nd_xxx \
  --token uob_live_xxx

# 常用可选参数：
#   --cmdline <sanitized|comm_only|full>   cmdline 脱敏策略（默认 sanitized）
#   --disable-proc                         完全禁用进程列表上报（enabled = false）
#   --repo <owner/repo>                    指定拉取 Release 的 GitHub 仓库（默认 Cusnd/UniOB）
#   --version <tag|latest>                 指定探针版本（默认 latest）
#   --bin-url <url>                        指定自定义二进制下载地址

# 彻底卸载（停止服务并清理 unit / 二进制 / /etc/uniob / /var/lib/uniob）
curl -fsSL https://monitor.example.com/install.sh | sudo bash -s -- --uninstall
```

被控探针支持的二进制运行参数：`-c`/`--config`（默认 `/etc/uniob/agent.toml`）、`--state-dir`（默认 `/var/lib/uniob`，存放热迁移状态 `endpoint_override.toml` 与更新暂存目录 `update/`）、`--verify-staged-update`（由 `uniob-agent-update.service` root 助手调用以二次验证暂存包与 HMAC 签名）、`--allow-insecure-ws-for-test`、`--once`、`-V`/`--version`、`-h`/`--help`。

> 💡 安装一次后即可直接在网页 **「服务器」->「自动更新」** 中选择 `stable` / `github` / 自定义镜像源，对全部或指定节点下发 HMAC 签名的 `auto_update_v1` 自动更新指令（失败 `2s` 内自动回滚 `.prev`）。

---

## 本地开发命令

根目录 `package.json` 提供了常用工作流快捷指令（各子包独立维护依赖，未启用 npm workspaces）：

| 命令 | 说明 |
| :--- | :--- |
| `npm run build` / `npm run build:web` | 运行前端类型检查并构建静态资源至 `web/dist` |
| `npm run typecheck:web` | 运行前端 TypeScript 类型检查 |
| `npm run typecheck:worker` | 运行 Worker TypeScript 类型检查 |
| `npm run typecheck` | 顺序运行 `typecheck:web` 与 `typecheck:worker` |
| `npm run test:agent` | 运行 Rust 探针单元测试（`agent/Cargo.toml`） |
| `npm run test:hub` | 运行 Rust 自建中枢单测与 E2E 测试（`hub/Cargo.toml`） |
| `npm run test:worker` | 运行 Worker Vitest 单元测试与 Durable Object 集成测试 |
| `npm run test` | 顺序运行 `test:agent`、`test:hub` 与 `test:worker` |
| `npm run build:agent` | 编译 Rust 探针 Release 构建 |
| `npm run build:hub` | 编译 Rust 自建中枢 Release 构建 |

### 本地前后端联调

```bash
# 1. 初始化本地 D1 数据库迁移
npx --prefix worker wrangler d1 migrations apply uniob-meta --local

# 2. 终端 1：启动 Worker 本地开发服务（默认 http://127.0.0.1:8787）
npm --prefix worker run dev

# 3. 终端 2：启动 Vite 前端开发服务（自动代理 /api、/install.sh、/install-hub.sh、/releases 至 127.0.0.1:8787）
npm --prefix web run dev
```

## License

[MIT](./LICENSE)
