# UniOB

[![CI](https://github.com/Cusnd/UniOB/actions/workflows/ci.yml/badge.svg)](https://github.com/Cusnd/UniOB/actions/workflows/ci.yml)
[![Release](https://github.com/Cusnd/UniOB/actions/workflows/release.yml/badge.svg)](https://github.com/Cusnd/UniOB/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**简体中文** | [English](./README.en.md)

**轻量、只读、省心的多服务器监控与实时告警面板**——专为手握多台 Linux VPS（哪怕是 512M / 1G 小内存机器）的个人玩家与小团队设计。

你可以**零成本免费部署在 Cloudflare Workers**（无需专门买一台服务器挂面板），也可以**单文件一键自建**，还能随时在两种模式之间一键无感搬家。

---

## ✨ 为什么选择 UniOB？

- **🪶 羽量级探针，小鸡零负担**
  被控端只是单个 `< 2.5 MB` 的纯静态二进制文件，不依赖 Docker 或任何运行环境，常驻内存仅 **3~6 MB**，装在 512M 内存的入门 VPS 上也毫无存在感。
- **🔒 严格只读，绝不留远程控制后门**
  探针只读取系统状态，**没有 WebSSH、不支持下发任意命令、不拉起外部子进程**，查看进程时还会自动脱敏命令行里的密码与密钥。就算面板地址暴露在外，也不必担心监控工具变成“肉鸡控制端”。
- **☁️ / 🖥️ 云端与自建双模，点两下鼠标就能搬家**
  - **不想买面板机？** 直接跑在 Cloudflare Workers 免费版上。平时没人看网页时探针自动切入省流批次上报（免费额度即可轻松带起几十到上百台机器），遇到 CPU 暴涨或内存越界依然 **0 秒即时告警**；打开网页瞬间恢复秒级丝滑曲线。
  - **喜欢 24 小时挂副屏盯秒级曲线？** 一条命令在任意 VPS 装好自建版 `uniob-hub`（免 Docker、自带本地数据库），还能留一个免费 Cloudflare Worker 当**「自建面板掉线提醒」**——就算装面板的机器自己断电拔线，云端也会第一时间替你发告警。
  - 两套模式界面与功能完全一致。哪天想换地方，在网页里填一个**迁移口令**，所有服务器、告警规则和月度流量统计就会自动平滑切过去（新面板异常还会自动退回）。
- **📊 盯盘与排障恰到好处**
  - **高密多视图大盘**：支持卡片（主图可一键切换 **实时网络 / CPU / TCP 延迟 / 内存**）、矩阵与列表视图。
  - **按需进程透视**：只在你点开某台机器详情时实时抓取进程排行，关掉页面自动停采，平时零额外开销。
  - **可选 TCP 网络质量检测**：支持配置多路目标（内置三网、亚太、欧美预设）持续追踪延迟波动与丢包率，直观定位线路抽风。
  - **省心日常维护**：内置月度流量统计、多渠道告警通知，以及网页端**一键升级全部节点探针**（升级异常自动回滚）。

---

## 🧭 两种部署模式怎么选？

| 对比维度 | ☁️ Cloudflare Workers 边缘版 | 🖥️ 自建 `uniob-hub` 独立版 |
| :--- | :--- | :--- |
| **适合谁** | 手头几台到几十台机器、不想专门维护面板机的玩家 | 机器较多、数据想全留本地，或喜欢 **24×7 全天挂大屏**看秒级跳动的玩家 |
| **需要准备服务器吗** | **不需要**（直接跑在 Cloudflare 全球边缘网络） | 任意一台闲置 Linux VPS（单文件运行，内存占用仅十几 MB，自带本机监控） |
| **日常费用** | **免费版零成本**即可满足日常按需看盘；超大机群可升 Paid（`$5/月`） | **云端零账单**（全走本地硬盘，每秒写多少次都不心疼配额） |
| **面板机宕机兜底** | Cloudflare 边缘天然高可用 | 可选开启免费 Cloudflare **云端掉线提醒**，面板失联照样告警 |
| **手把手完整教程** | 👉 **[Cloudflare 从零部署指南（人话版）](./docs/deploy-cloudflare.md)** | 👉 **[自建中枢与无感搬家指南（人话版）](./docs/deploy-self-hosted.md)** |

> 💡 **不用纠结选错**：你可以先花 10 分钟搭好免费的 Cloudflare 版用起来，日后买到合适的机器再一键热迁移到自建版（反过来迁回云端也一样）。

---

## 🚀 快速开始

### 方式一：部署到 Cloudflare Workers（免服务器）

> 详细图文防坑步骤（含绑定自定义域名与 Cloudflare Zero Trust 邮箱登录配置）请看 **[《Cloudflare Workers 从零部署教程》](./docs/deploy-cloudflare.md)**。

本地装有 `Node.js >= 20` 时，只需 4 步即可上线：

```bash
# 1. 克隆代码并分别安装前后端依赖
git clone https://github.com/Cusnd/UniOB.git && cd UniOB
npm --prefix web install && npm --prefix worker install
npm run build:web

# 2. 登录 Cloudflare 并创建 D1 数据库（将输出的 database_id 填入 worker/wrangler.jsonc）
npx --prefix worker wrangler login
npx --prefix worker wrangler d1 create uniob-meta

# 3. 初始化远程数据库表结构
npx --prefix worker wrangler d1 migrations apply uniob-meta --remote

# 4. 一键发布上线
npm --prefix worker run deploy
```

<details>
<summary><b>不想在本地配环境？点此查看 Fork + GitHub Actions 自动部署方法</b></summary>

Fork 本仓库后，前往 GitHub 仓库的 **Settings -> Secrets and variables -> Actions** 配置以下参数，即可在 **Actions -> Deploy to Cloudflare Workers** 中一键构建并部署：

| 类型 | 名称 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| **Secret** | `CLOUDFLARE_API_TOKEN` | ✅ | 具备 Workers Scripts、D1、Workers Routes 权限的 API Token |
| **Secret / Variable** | `CLOUDFLARE_ACCOUNT_ID` | ✅ | 你的 Cloudflare Account ID |
| **Variable** | `CF_D1_DATABASE_ID` | ✅ | 已创建的 `uniob-meta` D1 数据库 UUID |
| **Variable** | `CF_CUSTOM_DOMAIN` | 可选 | 自定义面板域名（如 `monitor.example.com`） |
| **Variable** | `ENABLE_CF_AUTO_DEPLOY` | 可选 | 设为 `true` 时，推送 `main` 或发布新版本后自动部署 |
| **Variable** | `CF_AUTH_MODE` | 可选 | 默认 `"builtin"`（内置密码）；如需接入 Zero Trust 可设为 `"cf_access"` |
| **Variable** | `CF_WORKERS_DEV` | 可选 | `"true"` / `"false"`（启用 Zero Trust 时建议设为 `"false"`） |
| **Variable** | `CF_ACCESS_TEAM_DOMAIN` | 可选 | Zero Trust Team 域名（如 `your-team.cloudflareaccess.com`） |
| **Secret / Variable** | `CF_ACCESS_AUD` | 可选 | Zero Trust 应用的 Audience (AUD) Tag |
| **Variable** | `CF_ACCESS_ALLOWED_EMAILS` | 可选 | 允许登录的管理员邮箱（多个用英文逗号分隔） |

</details>

---

### 方式二：一键安装自建版 `uniob-hub`（免 Docker）

> 包含 Cloudflare Tunnel（免开公网端口）/ Caddy / Nginx 反代配置、云端掉线提醒与一键搬家的完整步骤，请看 **[《自部署 `uniob-hub` 完整教程》](./docs/deploy-self-hosted.md)**。

在任意带 `systemd` 的 Linux 服务器（支持 `x86_64` / `aarch64`）上执行：

```bash
curl -fsSL https://raw.githubusercontent.com/Cusnd/UniOB/main/scripts/install-hub.sh.tmpl | sudo bash -s -- \
  --domain https://hub.example.com
```

安装完成后服务默认安全监听本机 `127.0.0.1:8787`（并自动把当前宿主机作为本机节点纳入监控），使用 Cloudflare Tunnel 或任意反向代理为其配置 HTTPS 域名即可打开网页初始化管理员密码。

---

### 接入与管理被控服务器

1. **添加节点**：登录面板进入 **「服务器」** 页面，点击新增节点并复制生成的单行安装命令，在被控 Linux 机器上粘贴运行即可秒级上线。
2. **日常升级与改配**：装好一次后，无论是开关**网络质量检测**、**升级探针版本**还是**跨面板迁移**，都可以在网页端直接完成，无需再逐台 SSH 登录。
3. **干净卸载**：如需移除某台机器上的探针或自建面板，追加 `--uninstall` 即可彻底清理服务与残留文件：

```bash
# 卸载被控端探针
curl -fsSL https://你的面板域名/install.sh | sudo bash -s -- --uninstall

# 卸载自建面板 uniob-hub
curl -fsSL https://raw.githubusercontent.com/Cusnd/UniOB/main/scripts/install-hub.sh.tmpl | sudo bash -s -- --uninstall
```

---

## 📚 文档与进阶阅读

**部署与使用指南**
- ☁️ **[Cloudflare Workers 边缘中枢从零部署教程（人话版）](./docs/deploy-cloudflare.md)** — 免费额度说明、5 步上线与 Zero Trust Access 放行配置
- 🖥️ **[自部署 `uniob-hub` 与无感热迁移教程（人话版）](./docs/deploy-self-hosted.md)** — 单文件自建、反代暴露、云端掉线提醒与双模互迁
- 🌐 **[网络质量检测说明](./docs/features/network-quality.md)** — 多路 TCP 延迟探测预设、节点覆盖与配额说明

**底层设计与二次开发**（面向想了解实现原理或参与贡献的开发者）
- 🏗️ **[架构设计与省流原理](./docs/ARCHITECTURE.md)** · 📐 **[技术规范与计费测算](./docs/SPEC.md)** · 🔌 **[HTTP / WebSocket API 文档](./docs/API.md)**
- 🤝 **[参与贡献与本地编译指南](./CONTRIBUTING.md)** · 🔒 **[安全策略](./SECURITY.md)** · 📝 **[更新日志](./CHANGELOG.md)**

## License

[MIT](./LICENSE)
