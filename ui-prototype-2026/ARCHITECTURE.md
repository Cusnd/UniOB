# UniOB Horizon 2026 — UI 架构规范与双界面切换指南

本文档定义 `ui-prototype-2026` 原型的核心设计系统、Web 平台工程规范，以及未来将其接入 UniOB 主工程（与现有 `web/` 面板平滑并存/双 UI 切换）的演进方案。

---

## 1. Horizon 2026 设计系统（Obsidian Dark & Porcelain Light）

### 1.1 双极表面体系与色彩令牌
原型基于 Tailwind CSS v4 与现代 CSS `light-dark()` + `color-scheme` 双引擎构建（在不支持 `light-dark()` 的环境下自动回退至 `@media (prefers-color-scheme: dark)` 与 `[data-theme]` 覆盖）：

| 令牌 | Obsidian Dark（深邃碳黑） | Porcelain Light（冷瓷高对比） | 用途 |
| :--- | :--- | :--- | :--- |
| `--bg-canvas` | `#07090e` | `#f5f7fa` | 全局画布背景（叠加环境径向光晕） |
| `--bg-surface` | `#0c1018` | `#ffffff` | 一级 Bento 卡片与表格表面 |
| `--bg-elevated` | `#111723` | `#f1f5f9` | 次级浮层、下拉菜单、命令中心面板 |
| `--bg-glass` | `rgba(12, 16, 24, 0.78)` | `rgba(255, 255, 255, 0.84)` | 52px 顶部玻璃态状态栏与抽屉顶栏 |
| `--border-subtle` | `rgba(148, 163, 184, 0.12)` | `rgba(15, 23, 42, 0.085)` | 1px 精细分隔线 |
| `--shadow-card` | 暗色投影 + `inset 0 1px 0 rgba(255,255,255,0.055)` | 柔和多层白瓷阴影 | 卡片层次与顶部微高光 |
| `--text-primary` | `#f1f5f9` | `#0f172a` | 标题与关键指标数值（>= 14:1） |
| `--text-secondary` | `#94a3b8` | `#475569` | 次级标签与描述文案（>= 4.5:1） |
| `--text-muted` | `#7d8da5` | `#526075` | 辅助说明与时间戳（>= 4.5:1） |

### 1.2 三套强调色预设与双密度切换
- **强调色切换 (`html[data-accent]`)**：
  - `emerald`（翡翠监控绿，默认）：`#059669` / `#10b981`
  - `indigo`（深空靛蓝）：`#4f46e5` / `#6366f1`
  - `cyan`（极光青蓝）：`#0891b2` / `#06b6d4`
- **密度切换 (`html[data-density]`)**：
  - `comfortable`（舒适默认）与 `compact`（高密 NOC 大屏），通过 `--density-pad`、`--density-gap`、`--density-row-py` 统一调控卡片与表格间距。
- **数字排版**：所有遥测指标（CPU %、Steal、流量、速率、PID、时间戳）强制使用 `.font-mono-num`（`JetBrains Mono` + `tabular-nums`）消除实时刷新时的宽度抖动。

---

## 2. 2026 Web 平台工程硬规范

1. **原生顶层 `<dialog>` 模态体系**：
   - 所有模态面板（`NodeInspectorSheet` 侧滑透视、`AddServerWizardModal` 部署向导、`AuthPreviewModal` 鉴权展厅、`⌘K` 全局命令中心、编辑弹窗）均使用原生 `<dialog>` + `.showModal()` 渲染在浏览器 Top Layer。
   - **禁止向 `html` 或 `body` 写入 `overflow: hidden` / `position: fixed`**，改用 `dialog:modal { overscroll-behavior: contain; }` 与 `dialog::backdrop { overflow: hidden; overscroll-behavior: contain; }` 阻止滚动穿透。
   - `<dialog>` 元素本身不添加无条件 `flex`/`grid` 类（避免覆盖关闭态 `display: none`），内部统一包裹唯一布局子容器；不使用冗余的 `role="dialog"` 与 `aria-modal="true"`。
2. **单行 Tablist 指示器**：
   - 使用 `role="tablist"` + `button[role="tab"][aria-selected]`，选中态下划线由 `[role="tab"][aria-selected="true"]::after` 的 `border-block-end: 2px solid var(--accent-primary)` 绘制，兼容 Forced Colors 且不改变字重/内边距避免布局抖动。
3. **无障碍可排序表格**：
   - 横向滚动容器声明 `tabIndex={0} role="region" aria-labelledby={captionId}`；表头使用 `<th scope="col"><button type="button">`；仅在当前排序列标记 `aria-sort`；文本排序采用 `Intl.Collator(undefined, { numeric: true, sensitivity: "base" })`；表外设 `role="status"` 播报排序变更。
4. **滚动条与降动效兼容**：
   - 使用标准 `scrollbar-width: thin; scrollbar-color: ...;`（严禁对 `scrollbar-color` 加 `transition`），并以 `@supports not (scrollbar-color: auto)` 包裹 `::-webkit-scrollbar` 回退。
   - 完整响应 `@media (prefers-reduced-motion: reduce)`。
5. **uPlot Top Layer 自适应**：
   - 位于 `<dialog>` 内的 uPlot 图表在打开时通过 `requestAnimationFrame` + `ResizeObserver` 动态调用 `uplot.setSize()`，避免模态框首帧宽度为 0 的裁剪问题，并依据 `resolvedTheme` 注入明确坐标轴与网格颜色。

---

## 3. 原型数据与页面拓扑

- **状态底座 (`src/data/mockStore.ts`)**：
  - 预置 **12 台跨地域节点**（覆盖 `亚太核心 BGP`、`欧美生产集群`、`AI 推理与计算`、`边缘与灾备节点` 4 个分组），精准覆盖：健康多核节点、高 `steal: 6.8%` KVM 争抢节点、1G 小内存高压 `~92%` 节点、月流量 `~94%` 即将耗尽节点、`proc_enabled: false` 隐私保护节点、维护静默节点与离线告警中节点。
  - 启动即预填充每台在线节点 60 个 `liveSeriesByNode` 采样与 24 点 Sparkline，支持 `1s` / `2s` / `paused` 仿真流速切换，并提供 `1h`/`24h`/`7d`/`30d`/`1y` 含峰值包络（`cpu_max` / `mem_max`）的历史序列与 `/proc` 进程（含 `R`/`S`/`D`/`Z` 状态）模拟。
- **四大工作区路由**：
  1. `dashboard`（`FleetOverviewPage`）：Bento 4 格驾驶舱 + `bento`/`table`/`matrix` 三视图机群展现。
  2. `nodes`（`NodesOpsView`）：服务器台账、分组筛选、静默开关、密钥轮换、属性编辑与移除确认。
  3. `migration`（`HubMigrationStudio`）：Cloudflare SCCH（`$0/月`）⇄ 自建 `uniob-hub`（Rust + SQLite WAL）双模拓扑对比、两步金丝雀热迁移演练台、Cloudflare 云端看门狗配置及 JSON Bundle 导出预览。
  4. `alerts`（`AlertsCenterView`）：实时告警事件时间线、告警规则引擎（含 6 项一键黄金模板）、Telegram / Webhook 通知渠道与测试推送。

---

## 4. 未来主项目双 UI 平滑切换方案

`ui-prototype-2026/src/types.ts` 与 `src/utils/format.ts` 完整保留了主项目 `web/src/types.ts` 与 `web/src/utils/format.ts` 的全部业务契约，仅新增了 `PrototypeNode`（派生地理/Sparkline 视图模型）和原型工作台控制状态。未来接入主仓库时推荐采用以下低风险切换架构：

### 方案 A：构建期环境变量双入口（零包体积负担，推荐）
1. 在主项目 `web/src/` 中保留现有 UI 为 `legacy/`，将 Horizon 2026 组件迁入 `web/src/horizon/`，两者共用 `web/src/api/client.ts`、`web/src/hooks/useFleetSocket.ts` 与 `web/src/types.ts`。
2. 在 `web/src/main.tsx` 或 `vite.config.ts` 中通过 `VITE_UI_THEME=horizon2026 | classic` 条件挂载根组件（Workers Static Assets 构建时树摇移除未选中 UI，保持静态资源极小体积）。

### 方案 B：运行时灰度切换（同包并存，管理员按账号预览）
1. 在 `App.tsx` 顶层读取 `localStorage.getItem("uniob_ui_edition")`（支持 URL 参数 `?ui=horizon` 覆写），通过 `React.lazy(() => import("./horizon/HorizonApp"))` 按需懒加载 Horizon 2026 壳层。
2. 编写轻量适配器 `useHorizonLiveAdapter()`：
   - 将 `api.getNodes()` 返回的 `NodeSummary[]` 映射为 `PrototypeNode[]`（从 `node.tags` 或 `region:` 前缀解析 `region_code` / `region_flag`，并从 `liveSeriesByNode` 截取最近 24 帧作为 `sparkline_cpu/rx/tx`）；
   - 将 `api.getNodeHistory`、`api.createNode`、`api.rotateToken`、`api.smartMigrate`、`api.getWatchdogConfig` 等真实 REST 接口直接绑定至 Horizon 2026 组件 Props（组件签名已与真实 API 载荷一一对齐）；
   - 将 `useFleetSocket` 的 `procsPacket` 实时接入 `NodeInspectorSheet`，仅在用户打开抽屉且切换到 `procs` 标签时自动发送 `{"op":"sub_node", "nodeId", "proc": true}`，关闭抽屉立即发送 `unsub_node`，严格维持 Cloudflare SCCH 零热路径写入与 `$0/月` 免费额度特性。
