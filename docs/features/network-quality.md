# 网络质量 TCP 探测与 Bento 卡片观测规范

> **定位**：可选的主动式公网 IPv4 TCP 建连探测扩展（`network_quality_v1`）及总览大盘 Bento 主指标观测规范。默认关闭（`enabled: false`），不影响现有主机资源采集精度、Idle 5 分钟批量 cadence 与零行写基线。

---

## 1. 功能概览与设计边界

- **探测机制**：由 `uniob-agent`（以及自建 `uniob-hub` 本机采集器 `hub-local`）内置的共享 Rust 探测运行时（[shared/network_quality.rs](../../shared/network_quality.rs)）对配置的公网 IPv4 目标周期性发起 `TcpStream::connect_timeout` 建连探测，测量 DNS + TCP 三次握手连通性与建连耗时（`connect_ms`），记录滚动失败率并按段保留历史轨迹。
- **失败率语义**：统计的是到目标端点的 **已完成 DNS/TCP 建连尝试失败率**，而非 ICMP 丢包率；支持任意可自定义 TCP 端口（默认 `80`，常见 `443` 等）。
- **零侵入资源采集**：
  - 所有扩展数据复用现有 `ctrl` / `m` / `mb` WebSocket 帧的顶层 `network_quality` 字段，**绝不写入 16 元 `CompactMetricTuple` 或 `mb.last`**。
  - 扩展解析失败时隔离丢弃扩展本身，**不中断或覆盖原有主机 CPU/内存/磁盘/流量数据**。
  - Idle（`mode = 0`）下仍严格按 5 分钟 UTC 相位批量上报，不额外唤醒 Durable Object。

---

## 2. 目标配置模型与预设（`1..=8` 路，`10..=300` 秒）

管理端在 **「服务器」（节点运维）→「网络检测」**（`NetworkQualitySettings.tsx`）配置全局设置，或在单个节点的详情 / 编辑抽屉中设置节点级策略。

| 存储位置 | Key | 结构 | 默认值 |
| :--- | :--- | :--- | :--- |
| 全局设置 | `network_quality_config` | `Config` (`{ enabled, interval_sec?, targets }`) | `enabled: false`，`interval_sec: 20`，广东三网默认 3 目标 |
| 单节点覆盖 | `network_quality_node:<id>` | `NodeOverride` (`{ mode: "inherit" \| "off" \| "custom", config? }`) | `{ mode: "inherit" }` |

### 2.1 字段校验规则
- **`targets`**：`1..=8` 个目标对象，不允许重复 `id`，严禁未声明字段。
  - `id`：合法 slug，`^[a-z0-9][a-z0-9_-]{0,23}$`（1–24 字符）。
  - `enabled`：布尔值，控制单路是否实际执行探测。
  - `label`：展示名称，经 `trim()` 后 `1..=32` 字符，禁止控制字符。
  - `region`：可选地域标签，经 `trim()` 后 `<= 64` 字符；空字符串或 `null` 时规范化为省略该字段。
  - `host`：小写 ASCII 域名或公网 IPv4 字面量（`<= 253` 字符）；禁止 URL、端口后缀、路径、凭据与通配符，私网/保留 IPv4 字面量在保存期即拒绝。
  - `port`：整数 `1..=65535`（缺省默认 `80`）。
  - `address_family`：固定 `"ipv4"`。
- **`interval_sec`**：探测周期整数秒，范围 `10..=300`，默认 `20`。

### 2.2 前端快速预设（`NETWORK_PRESETS`）
管理端提供 3 套一键预设模板（[web/src/utils/networkQuality.ts](../../web/src/utils/networkQuality.ts)）：
- **`cn-3net`（三网默认 CT/CU/CM）**：广东电信（`ct`）、联通（`cu`）、移动（`cm`），TCP `80`（`gd-{ct,cu,cm}-v4.ip.zstaticcdn.com`）。
- **`apac`（亚太节点 HK/JP/SG）**：香港（`hk`）、东京（`jp`）、新加坡（`sg`），TCP `443`。
- **`global`（海外节点 US/EU/JP）**：美东（`us`）、法兰克福（`eu`）、东京（`jp`），TCP `443`。

---

## 3. 规范化排序与 `config_id` 向后兼容规则

为保证 Rust 与 TypeScript 双端计算出的 `config_id` 与 `target_revision` 字节级一致（由 [shared/fixtures/network-quality-v1.json](../../shared/fixtures/network-quality-v1.json) 回归校验）：

1. **规范目标排序**：内置 ID 按固定优先级 `ct (0) -> cu (1) -> cm (2)` 排在最前，其余自定义目标按 ASCII 字典序升序排列。
2. **`target_revision` 计算**：对以下 7 元紧密 JSON 数组（无空格 UTF-8）取小写 SHA-256 hex：
   ```json
   [id, enabled, label, region ?? null, host, port, "ipv4"]
   ```
   > 注意：`Target` JSON 对象序列化时会省略空的 `region` 键；但在计算规范数组 `target_array` 时，缺省/空 `region` 在索引 `3` 位置固定编码为 `null`。
3. **`config_id` 计算（v1 向后兼容规则）**：
   - **当 `interval_sec == 20`（默认值）**：序列化 `Config` / `Control` 时 **省略 `interval_sec` 键**，`config_id` 对 3 元数组取 SHA-256，与 v1 基准夹具 `d6c085f8...` 保持字节级兼容：
     ```json
     ["network_quality_v1", enabled, target_arrays]
     ```
   - **当 `interval_sec != 20`**：序列化保留 `interval_sec`，`config_id` 对 4 元数组取 SHA-256：
     ```json
     ["network_quality_v1", enabled, target_arrays, interval_sec]
     ```

---

## 4. 探针调度器、段切换与滚动聚合

### 4.1 并发与有界资源隔离
- **有界线程池**：1 条调度线程 + 惰性扩展、上限封顶的解析/连接工作线程（最多 `2 * MAX_TARGETS` = `16` 个工作线程，单线程栈 `128 KiB`），不针对每次探测动态无限开线程；若某目标因系统 `getaddrinfo` 阻塞导致解析卡死，后续轮次自动跳过该占用目标，不会把阻塞扩散到其他目标或主采集线程。
- **独立超时预算**：`1500 ms` TCP 建连超时，与 DNS 解析时间预算分离。
- **帧背压上限**：Agent 内存发送队列最多保留 `270` 条未送达样本且丢弃超过 `30 分钟` 的过期未发送样本；单帧 `network_quality` 上报不超过 `128 KiB` UTF-8（Worker 端校验上限放宽至 `720` 条 / `384 KiB` 以兼容批次波动）。

### 4.2 `segment_id` 分段与滚动窗口
- 每当目标的 `target_revision` 或解析得到的 `remote_ip` 发生变化时，探针自动递增分配新的会话内 `segment_id`，历史曲线在不同目标配置或 DNS 解析 IP 切换之间形成清晰断点（不混淆延迟基线）。
- **实时 `latest` 窗口**：对同一 `(target_id, segment_id)` 取尾点之前 `120s` 内的最近至多 `6` 次尝试，计算成功样本的中位数延迟 `latency_median_ms`（全部失败则为 `null`）与失败率 `failure_rate_pct`（`failures / attempts * 100`）。
- 支持的结果枚举：`ok` | `connect_timeout` | `connection_refused` | `dns_error` | `dns_timeout` | `network_error`。配置校验或 SSRF 拦截至策略错误写入 `config_error`，不伪造正常尝试记录。

---

## 5. 独立环形存储与游标分页查询

Worker DO 与自建 `uniob-hub` SQLite 使用完全一致的 JSON 环形分块表（不写 D1，不混入资源 TSDB 二进制块）：

| 存储表 | 容量与保留窗口 | 说明 |
| :--- | :--- | :--- |
| `network_quality_chunk_10m` | `146` 槽 × `10m` = **`24h`** | 去重 `sample_id` 写入原始尝试；入库容忍 `<= 60s` 未来时钟偏差与最多 `30m` 回溯 |
| `network_quality_5m_chunk_1h` | `721` 槽 × `1h` = **`30d`** | 按 `(bucket_ts_5m, target_id, segment_id)` 从原始块重构的加权聚合 |
| `network_quality_state` | 每节点 `1` 行 | 保存最新状态快照 `State`，仅在接收到新采样或配置状态变化时落盘 |

- **历史查询接口**：`GET /api/nodes/:id/network-quality?range=1h|24h|7d|30d&cursor=...`
  - `1h` / `24h`：逐块流式解码原始数据并还原每点的 `120s` 滚动失败率，`resolution_sec = control.interval_sec ?? 20`。
  - `7d` / `30d`：返回 5 分钟分段聚合点（`resolution_sec = 300`），保留 `attempts`、`failures`、`success_count`、`latency_sum_ms`、`latency_ms`、`latency_max_ms`，严禁跨桶简单平均百分比。
  - **分页限制**：单页最多返回 `3,000` 个查询点或 `1,000,000` UTF-8 字节；不透明 `cursor` 绑定 `(node_id, range, to, bucket, offset)` 并固定查询终止时间 `to`，有效期 `30 分钟`（超时或参数不匹配返回 `400`）。
- **迁移与 Bundle 边界**：`/api/export/bundle` 与 `/api/import/bundle` **包含**全局与节点级网络质量配置，并在导入前执行完整策略校验；节点历史探针记录保留在原中枢，不随 Bundle 迁移。

---

## 6. 总览 Bento 卡片主指标与离线展示

总览页（`FleetOverviewPage.tsx`）在 **「卡片」**（`bento`）视图下结合 `FleetBentoGrid.tsx`、`cardMetrics.ts` 与 `useHorizonPrefs.ts` 提供主图表自定义能力：

- **可切换卡片主图表指标（`cardPrimaryMetric`）**：
  - `net`（**实时网络**，默认）：主图表展示下行/上行双向实时速率曲线（`ObservabilityChart`）。
  - `cpu`（**CPU**）：主图表展示实时 CPU 使用率曲线（0–100%）。
  - `latency`（**TCP 延迟**）：主图表展示节点已启用且最近成功（`result === "ok"`）各探测目标 `latency_median_ms` 的中位数走势（`ms`）。
  - `mem`（**内存**）：主图表展示实时内存占用率曲线（0–100%）。
- **底部 4 格副指标动态补位**：当主图表切为 `cpu` 或 `mem` 时，底部 4 格微型进度条自动将该槽位替换为「实时网络」，与另一项资源指标、磁盘和月流量并列，避免信息重复或缺失。
- **离线卡片降噪占位**：离线节点（`!node.online`）在主图表区域显示中性灰色虚线基线与「离线」标识（右上主读数显示 `—`），不再绘制误导性的 `0` 值绿色实时折线或亮色进度条；新上线尚无采样点的节点显示「等待数据」。

---

## 7. SSRF 防护与安全边界

- **严格公网 IPv4 策略**：保存配置与探针 DNS 解析完成后均执行同一套公网 IPv4 检查，明确拒绝：`0.0.0.0/8`、私网 `10/8` / `172.16/12` / `192.168/16`、回环 `127/8`、链路本地 `169.254/16`、CGNAT `100.64/10`、组播/保留 `>= 224.0.0.0`、文档网段（`192.0.2.0/24`、`198.51.100.0/24`、`203.0.113.0/24`）及基准测试网段 `198.18.0.0/15`。
- **抗 DNS 重绑定（Pin Validated SocketAddr）**：探针先通过受控解析校验所有 A 记录，再将验证通过的具体 `SocketAddrV4` 直接交给 `TcpStream::connect_timeout`，杜绝 TOCTOU 二次解析绕过；透明代理/Fake-IP 环境中若解析返回 `198.18.0.0/15` 等保留地址，将直接上报 `config_error` 并停止探测该目标。
- **出站权限要求**：开启网络质量探测的节点需放行 UDP/TCP `53` DNS 解析及到所配目标端口的出站 TCP 连接；不监听任何入站端口，不需要 `CAP_NET_RAW` 或额外系统调用。

---

## 8. 资源与 Cloudflare 配额开销

| 工况（按默认 `3` 目标 / `20s` 间隔实测） | DO SQLite 增量写入/节点/日 | 合计 DO 写入/节点/日（含资源监控） | 稳态 DO 存储增量/节点 |
| :--- | ---: | ---: | ---: |
| **关闭状态（仓库默认）** | `0` 行 | `888` 行（Idle） | `0 MB` |
| **Idle 静默模式（5m 批量 `mb`）** | `+1,034` 行 | `1,922` 行（Workers Free 约可带 **~52 台**） | `~17.7 MB`（`~6.17 MB` 10m + `~11.54 MB` 5m） |
| **24x7 Live 实时看盘模式** | `+13,130` 行 | `19,202` 行 | `~17.7 MB` |

- `targets` 数量增至 `4~8` 个或缩短 `interval_sec`（最低 `10s`）会按比例增加每次 `m`/`mb` 报文大小、10m 块序列化长度与聚合行写；自建 `uniob-hub` 模式下全部由本地 SQLite WAL 承担，不消耗 Cloudflare 配额。
