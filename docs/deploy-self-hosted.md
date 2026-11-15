# 自部署 `uniob-hub` 独立中枢教程：CF 看门狗与无感热迁移（人话版）

> **一句话定位**：受够了传统自建监控动不动就要装 Docker、拉起 Postgres + Redis + Nginx 一套全家桶吃掉小半个 G 内存？`uniob-hub` 是一个 **只有约 4~5 MB 的纯静态单文件 Rust 程序**，不挑系统、免装 Docker、自带网页界面和 SQLite WAL 高速环形时序库，常驻内存只有 **十几 MB**，3 分钟就能在任何一台闲置 Linux 小鸡上跑起来！
>
> 💡 *如果你连一台常驻 VPS 都不想拿出来挂面板，可以先看姊妹篇 👉 [《Cloudflare Workers 边缘中枢从零部署教程（人话版）》](./deploy-cloudflare.md)。更妙的是：这两套模式用的是一模一样的界面和探针协议，随时可以点两下鼠标在两边来回搬家！*

---

## 1. 先说人话：什么时候该上自部署 `uniob-hub`？

既然免费的 Cloudflare Workers 已经能带几十台机器了，为什么 UniOB 还要专门用 Rust 再写一个 100% 同构的自建中枢 `uniob-hub`？

只要你符合下面任意一条，自建 `uniob-hub` 绝对让你爽到飞起：

1. **你是「24 小时挂大屏狂魔」**：你喜欢在副屏、iPad 或者工作室电视上全天候开着监控墙，看着几十台小鸡的 CPU、网速曲线 **1 秒一跳** 丝滑滚动——在自己的小鸡上跑本地 SQLite WAL，每秒写几千次也不花一分钱，再也不用算计 Cloudflare 每天那 10 万次免费写入够不够造！
2. **你手头机器巨多（100 ~ 500+ 台）**，且希望云端账单永远焊死在 **`$0.00/月`**。
3. **你有数据主权洁癖**：所有历史曲线、按需抓取的进程快照、Telegram 密钥，统统只存在你自己硬盘上的一个 `uniob.db` 单文件里，拷走文件就等于拷走了整个监控中心。
4. **装好顺手白送本机监控（`hub-local`）**：`uniob-hub` 内置了零网络开销的宿主机采集器（`self_probe`），服务一启动就自动直读本机 `/proc` 生成一个叫 **`Hub Local`（`hub-local`）** 的节点——连本机的 `uniob-agent` 都省得装了！
5. **内置可选探测、大盘主指标与 `auto_update_v1` 分发池**：同套界面内置 **1~8 路自定义公网 IPv4 TCP 延迟探测**（[详见网络质量指南](./features/network-quality.md)）、**总览 Bento 卡片主指标切换**（`实时网络` / `CPU` / `TCP 延迟` / `内存`），以及通过本地 `/usr/local/share/uniob-hub/releases/`（`/releases/*`）或 GitHub Releases / 自定义镜像源驱动手下小鸡自动升级的能力。

### 🏆 老司机的终极黄金组合拳：「自建扛日常 + 免费 CF 当看门狗与逃生舱」

纯自建监控自古以来都有一个致命死穴：**「如果装监控面板的这台机器自己拔网线、欠费停机或者母鸡炸了，谁来给你发告警？」** 它自己都断气了，当然发不出半个字！

UniOB 给出的标准答案是双剑合璧：
- **日常主力**：用自建 `uniob-hub` 接管所有小鸡，24 小时随便挂大屏盯秒级曲线，零云端成本；
- **场外裁判（云端自建面板掉线提醒）**：留一个免费的 Cloudflare Worker 挂在云端。自建中枢活着的时候，每 **5 分钟** 给 CF 递一封带加密签名的「平安信」（每天总共才耗 576 次免费请求，连 CF 免费额度的 1% 都不到）；**哪天自建中枢突然断气失联，CF 等不到平安信，立刻替你往 Telegram 狂喊救命！**
- **随时逃生**：万一自建这台机器一时半会儿修不好，在之前备份好的 CF 面板上随时能顶班救急！

---

## 2. 3 分钟一键安装 `uniob-hub`

找一台跑着主流 Linux（Debian / Ubuntu / Rocky / CentOS / Alpine 等，带 `systemd`，`x86_64` 或 `aarch64` 架构均可）的服务器，SSH 连上去直接开干！

### 一条命令装好跑起来

如果你之前已经按 [Cloudflare 教程](./deploy-cloudflare.md) 部署过一个边缘节点（比如 `monitor.example.com`），直接从你的 CF 域名拉安装脚本速度最快（连国内/单栈 IPv6 机器都能满速下二进制）；如果完全没搭过 CF，也可以直接从 GitHub 拉脚本裸装：

```bash
# 姿势 A（推荐）：从你已有的 CF 边缘节点拉取脚本并安装
curl -fsSL https://monitor.example.com/install-hub.sh | sudo bash -s -- \
  --listen 127.0.0.1:8787 \
  --domain hub.example.com

# 姿势 B（纯裸装）：还没有任何节点时，直接从 GitHub 拉取安装器
curl -fsSL https://raw.githubusercontent.com/Cusnd/UniOB/main/scripts/install-hub.sh.tmpl | sudo bash -s -- \
  --listen 127.0.0.1:8787 \
  --domain hub.example.com
```
*(小提示：把上面的 `hub.example.com` 换成你准备绑给这台自建中枢的域名；如果你本身就是 `root` 登录且系统里没装 `sudo`，把管道符后面的 `sudo ` 删掉直接 `| bash -s -- ...` 即可。)*

#### 常用安装参数人话速查：
- `--listen <addr>`：本机监听地址。**强烈建议保持默认的 `127.0.0.1:8787` 别改！** 只监听本机回环网卡，公网端口扫描器连你的毛都摸不到，后面配合 Tunnel 或反代暴露最安全。
- `--domain <domain>`：你的公网访问域名（如 `hub.example.com` 或 `https://hub.example.com`）。脚本会自动补齐 `https://` 写进配置里的 `public_url`，这样网页给你生成小鸡安装命令时域名才是对的，登录 Cookie 也会自动加上 `Secure` 安全锁。
- `--watchdog-url <url>` 与 `--watchdog-secret <secret>`：（可选）安装时顺手绑上 CF 云端「自建面板掉线提醒」心跳地址和密钥（第 5 节细讲，装完再改配置文件也完全一样）。
- `--import-bundle <文件路径或URL>`：（可选）安装的同时直接把旧中枢导出的 JSON 状态包灌进数据库（第 6 节热迁移神器）。
- `--repo <owner/repo>` / `--version <tag>` / `--bin-url <url>`：（可选）指定自定义 GitHub 仓库、指定版本号或私有二进制直链。

---

### 安装脚本到底往你机器里塞了啥？（目录全摊开，明明白白）

UniOB 绝不在你系统里乱拉屎，所有文件规规矩矩放在这 5 个标准位置：

| 落盘路径 / 服务名 | 它是干啥的？ | 权限与安全讲究 |
| :--- | :--- | :--- |
| `/usr/local/bin/uniob-hub` | **主程序二进制**（单文件约 4~5 MB） | `0755`，纯静态 `musl` 编译，不依赖系统 `glibc`，升级替换不断服 |
| `/etc/uniob-hub/hub.toml` | **核心配置文件** | `0640`（属组 `nobody`/`nogroup`），普通系统账号偷看不到里面的密钥 |
| `/var/lib/uniob-hub/uniob.db` | **唯一数据库文件**（SQLite WAL 模式，运行时伴生 `-wal` 和 `-shm`） | `0750`，所有节点、告警渠道、流量账本和 1 年环形历史曲线全在这一颗文件里 |
| `/usr/local/share/uniob-hub/web` | **前端网页静态资源**（自动拉取解压 `uniob-web-dist.tar.gz`） | 你打开域名看到的整个控制台界面就住在这儿 |
| `/usr/local/share/uniob-hub/releases` | **本地探针缓存池**（自动预存 `x86_64` 与 `aarch64` 的 `uniob-agent`） | 以后你手下其他小鸡向这台中枢拉 `/install.sh` 时，直接从这儿内网/直连高速下探针，不用去挤 GitHub！ |
| `uniob-hub.service` | **systemd 守护服务**（`/etc/systemd/system/uniob-hub.service`） | **强制以最低权限 `User=nobody` 运行！** 同时开启 `NoNewPrivileges=true`、`ProtectSystem=strict`、`ProtectHome=read-only`、`PrivateTmp=true` 沙箱铁笼，除了 `/var/lib/uniob-hub` 哪儿都不准写！ |

装完随手敲两行验个货：

```bash
systemctl status uniob-hub --no-pager
curl -s http://127.0.0.1:8787/api/auth/me
```

看到 `active (running)` 并且 `curl` 吐出 `{"authenticated":false,"needsSetup":true,"mode":"builtin"}` 这样的正常 JSON，说明中枢已经在本地欢快转起来了！接下来我们挑一种最顺手的方式把它安全通到公网上。

---

## 3. 怎么安全暴露到公网？（三选一，首推零开端口方案！）

> 🚨 **先说一条铁律：生产环境千万别图省事把监听改成 `0.0.0.0:8787` 然后裸奔访问 `http://IP:8787`！**
> 一来明文 HTTP 会让你的管理员密码和探针 `uob_live_` 令牌在公网上裸奔；二来 `uniob-agent` 探针和热迁移引擎为了防劫持与防 SSRF，**默认强制要求加密的 `wss://` 连接**！
> 下面三个方案都能免费帮你套上正规 HTTPS / WSS，按你的口味三选一：

---

### 🥇 方案一（强烈首推）：Cloudflare Tunnel (`cloudflared`) —— 防火墙入站全关，连 80/443 都不用开！

**为什么最爽**：你这台 VPS 的防火墙入站规则可以直接设成「拒绝一切外部连接」，连源站真实 IP 都藏得严严实实不怕被打！由机器内部的 `cloudflared` 主动往 Cloudflare 边缘打一条加密隧道，自动白送 HTTPS 证书和 WSS WebSocket 转发。

**操作步骤**：
1. 登录 [Cloudflare Zero Trust 控制台](https://one.dash.cloudflare.com/)，进入左侧 **Networks -> Tunnels**，点击 **Create a tunnel**，类型选 **Cloudflared**，起个名字比如 `uniob-hub`。
2. 在环境选择页点你的系统（比如 Debian / RedHat 及对应 64-bit / arm64），复制页面给出的那行 `sudo cloudflared service install <你的隧道Token>` 到这台服务器上执行。
3. 点 Next 进入 **Public Hostname（公开主机名）** 配置：
   - **Subdomain**：`hub`
   - **Domain**：选你的域名 `example.com`
   - **Service Type**：选 **`HTTP`**（注意不是 HTTPS！因为本机 `uniob-hub` 听的是纯 HTTP）
   - **URL**：填 **`127.0.0.1:8787`**
4. 点击 **Save tunnel**！现在直接用浏览器打开 `https://hub.example.com` 就能看到面板了！

> ⚠️ **防坑警报（开了 Zero Trust Access 必看！）**：
> 如果你还顺手在 Zero Trust -> Access 里给 `hub.example.com` 加了邮箱验证码登录保护，**请务必和 CF Worker 一样，再新建一个 `Action = Bypass` + `Include = Everyone` 的放行应用**，把下面这 4 条机器接口放行出来：
> - `hub.example.com/api/agent/ws`
> - `hub.example.com/install.sh`
> - `hub.example.com/install-hub.sh`
> - `hub.example.com/releases/*`
>
> **漏配这一步，你的小鸡探针连上来一定会被 `302` 踢去登录页而永远离线！**（详细图文点法见 [《Cloudflare 部署教程》第 4 节](./deploy-cloudflare.md#4-90-的人第一次必踩的大坑cloudflare-zero-trust-access-怎么给探针留后门bypass)）。

---

### 🥈 方案二：Caddy 反向代理（有公网 IP、喜欢极简配置）

如果你不想走 Cloudflare 隧道，喜欢小鸡直连你的面板机（低延迟）：先把 `hub.example.com` 的 DNS A/AAAA 记录解析到这台服务器 IP，放行防火墙的 `80` 和 `443` 端口。

Caddy 的好处是**自动申请续期 Let's Encrypt 证书，而且天生无感支持 WebSocket，一行废话配置都不用多写**！编辑 `/etc/caddy/Caddyfile` 加上这几行：

```caddyfile
hub.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8787
}
```

保存后重载即可：

```bash
sudo systemctl reload caddy
```

---

### 🥉 方案三：Nginx 反向代理（老牌稳健，但千万抄全 WebSocket 与超时配置！）

很多朋友机器上本来就跑着 Nginx，顺手加个站点最方便。但用 Nginx 反代 UniOB 有 **两个新手十有八九会栽跟头的大坑**：
1. **漏写 `Upgrade` 和 `Connection` 头**：Nginx 默认把 WebSocket 握手降级成普通 HTTP GET 扔给后端，`uniob-hub` 当场拒收甩回 **`426 Upgrade Required`**，探针死活连不上！
2. **没改默认的 `proxy_read_timeout`（默认只有 60 秒！）**：前面讲过，没人看网页时探针为了省流，**每 5 分钟（300 秒）才发一次数据包**。如果 Nginx 读超时还是默认的 60 秒，探针安静到第 60 秒就会被 Nginx 一刀咔嚓掐断连接，导致你所有小鸡每分钟都在日志里疯狂断线重连！

别自己手敲了，直接复制下面这份把坑全填平的完整配置（保存为 `/etc/nginx/conf.d/uniob-hub.conf`，把域名和 SSL 证书路径换成你自己的）：

```nginx
# 根据客户端是否请求升级协议，动态设置 Connection 头
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    listen [::]:80;
    server_name hub.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name hub.example.com;

    ssl_certificate     /etc/ssl/certs/hub.example.com.pem;
    ssl_certificate_key /etc/ssl/private/hub.example.com.key;

    # 放宽请求体上限，防止日后导入大号 JSON 状态包时报 413 错误
    client_max_body_size 16m;

    location / {
        proxy_pass http://127.0.0.1:8787;

        # 【必配 1】WebSocket 协议升级三件套（漏了探针必报 426！）
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # 【必配 2】透传真实 IP 与 HTTPS 标记（关系到防爆破限流与安全 Cookie）
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 【必配 3】拉长空闲超时到 1 小时，防止探针 5 分钟静默期被 60s 一刀掐断！
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
```

保存后检查语法并重载 Nginx：

```bash
sudo nginx -t && sudo systemctl reload nginx
```

---

## 4. `/etc/uniob-hub/hub.toml` 全字段人话拆解

一键脚本已经帮你生成了一份开箱即用的 `/etc/uniob-hub/hub.toml`。如果你想精细调教鉴权方式、改本机探针名字或者配看门狗，用 `sudo nano /etc/uniob-hub/hub.toml` 打开它——下面把每个字段掰碎了讲给你听（改完记得 `sudo systemctl restart uniob-hub` 生效）：

```toml
# ============================================================
# 1. 基础服务与路径配置 [server]
# ============================================================
[server]
# 本机监听地址。走 CF Tunnel / Caddy / Nginx 反代时强烈建议保持 127.0.0.1:8787
listen = "127.0.0.1:8787"

# SQLite WAL 单文件数据库存放位置
db_path = "/var/lib/uniob-hub/uniob.db"

# 前端网页静态文件目录与本地探针二进制缓存池
web_dir = "/usr/local/share/uniob-hub/web"
releases_dir = "/usr/local/share/uniob-hub/releases"

# 你的面板公网根地址（别带末尾斜杠）。用来拼装一键安装脚本地址和开启 HTTPS 安全 Cookie
public_url = "https://hub.example.com"

# 当本地 releases_dir 里没有对应架构探针时，兜底去哪个 GitHub 仓库下载 Release
github_repo = "Cusnd/UniOB"

# 给这台中枢起个响亮代号（可选，不填默认读取 /etc/hostname），看门狗发告警时会报这个名字
hub_label = "HK-Primary-Hub"


# ============================================================
# 2. 管理员登录鉴权配置 [auth]（两种模式任选）
# ============================================================
[auth]
# 可选值："builtin"（默认，内置密码登录） 或 "cf_access"（Cloudflare Zero Trust 邮箱登录）
mode = "builtin"

# --- 当 mode = "builtin" 时 ---
# 下面两项留空就行！
# 第一次用浏览器打开面板时，会自动弹出「初始化管理员密码」向导（密码最少 6 位，自动做 10 万次 PBKDF2 哈希存进数据库）。
# 会话 Cookie（uniob_session）有效期 7 天；同一个 IP 5 分钟内连续输错 5 次密码会自动触发 429 冷却防爆破。
# （注：如果你想在这儿手工硬编码 admin_password_hash，注意它只认 pbkdf2$100000$<salt>$<hash> 格式，不认裸 SHA-256，所以留空走网页向导最省心！）
session_secret = ""
admin_password_hash = ""

# --- 当 mode = "cf_access" 时（配合方案一 CF Tunnel 的黄金搭档！）---
# 开启后内置密码登录彻底关闭，后端会自动去 CF 拉取 RSA 公钥严格核验 Cf-Access-Jwt-Assertion 请求头与白名单邮箱：
# cf_access_team_domain = "你的团队名.cloudflareaccess.com"
# cf_access_aud = "你在 CF Access 应用里复制的那串 64 位 AUD"
# cf_access_allowed_emails = ["admin@example.com", "ops@example.com"]


# ============================================================
# 3. 宿主机零网络自监控 [self_probe]
# ============================================================
[self_probe]
# 默认 true！开启后 uniob-hub 每 30 秒直接读取本机的 /proc/stat、/proc/meminfo、磁盘和网卡流量，
# 自动在面板上维护一台本机节点 —— 这台机器根本不需要额外再装一遍 uniob-agent！
# 如果你纯粹只想拿它当空壳面板、不想监控宿主机本身，改成 false 即可。
enabled = true
node_id = "hub-local"
node_name = "Hub Local"


# ============================================================
# 4. 云端「自建面板掉线提醒」心跳上报 [watchdog]（详见第 5 节）
# ============================================================
[watchdog]
# 你部署在 Cloudflare Workers 上的看门狗心跳接收地址（留空则不启用上报）
url = "https://monitor.example.com/api/watchdog/ping"

# 与 CF Worker 面板上约定的 HMAC-SHA256 签名密钥
secret = ""

# 多久给 CF 寄一封平安信（秒），默认 300 秒（5 分钟），允许范围 60 ~ 3600 秒
interval_sec = 300

# 本机状态摘要展示参考超时（秒），默认 900 秒（注：真正拍板发失联告警的阈值在 CF Worker 面板上设！）
timeout_sec = 900

# 可选：单独覆盖上报给看门狗的中枢名称（不填则沿用上面的 [server].hub_label 或机器 hostname）
# hub_label = "HK-Primary-Hub"
```

*(附：所有关键项也支持通过环境变量如 `UNIOB_LISTEN`、`UNIOB_PUBLIC_URL`、`UNIOB_AUTH_MODE`、`WATCHDOG_URL`、`WATCHDOG_SECRET` 或命令行参数传入，生效优先级为：`命令行参数 > 环境变量 > hub.toml`。)*

---

## 5. 灵魂功能 1：给自建中枢配「自建面板掉线提醒」

再强调一次这个场景：**半夜三点，你装 `uniob-hub` 的这台主力小鸡所在机房光缆被挖断了，或者母鸡直接电源烧了。** 此时 `uniob-hub` 自己已经彻底断网停机，它肚子里的告警引擎再强也发不出半条 Telegram 消息！

这时候，Cloudflare 云端的 **「自建面板掉线提醒」** 就是你的救命稻草：
- 自建 `uniob-hub` 活着时，每 **5 分钟** 用 `HMAC-SHA256` 给当前时间戳和在线节点数签个名，POST 发给你的免费 Cloudflare Worker（`/api/watchdog/ping`）。
- Cloudflare Worker 身上挂着免费的 `*/5 * * * *` 定时巡检任务，每 5 分钟查一次岗：一旦发现距离上次收到平安信已经超过了你设定的 **失联阈值**，CF Worker 立刻动用它那边的 Telegram / Webhook 渠道给你发最高级别告警：**「坏了！你的自建中枢失联超时了！」**
- 等机房修好、自建中枢恢复上线发出第一封平安信，CF Worker 还会自动给你补一条 **「心跳已恢复」** 的报喜通知！
- **成本**：每天 288 次心跳 + 288 次巡检 = **576 次请求/天**（CF 免费额度是 100,000 次/天），**永久纯白嫖 `$0`**！

### 手把手三步接通自建面板掉线提醒

#### 第一步：确认你的 CF Worker 那边备好了「喇叭」和「侧门」
1. 你已经按 [Cloudflare 教程](./deploy-cloudflare.md) 部署好了一个免费的 CF Worker（假设域名是 `monitor.example.com`）。
2. 在 **CF Worker 的网页控制台** -> **「告警通知」** 里，已经添加并测试通过了至少一个 **Telegram 或 Webhook 通知渠道**（毕竟到时候是 CF 替你喊救命，它手里得有喇叭！）。
3. 如果你的 CF Worker 开了 Zero Trust Access，确认 `monitor.example.com/api/watchdog/ping` 已经在 **Bypass（绕过）** 名单里。

#### 第二步：在 CF Worker 面板打开「自建面板掉线提醒」并获取连接参数
1. 浏览器打开 **CF Worker 面板**（`https://monitor.example.com`），切到 **「服务器管理」** 页面。
2. 找到顶部的 **「面板迁移与运行模式」** 卡片，点击打开配置弹窗。
3. 在 Cloudflare 模式下，底部会显示 **「自建面板掉线提醒」** 区域：
   - 打开 **「开启自建面板掉线提醒」** 开关。
   - **失联判定时间**：默认选 **「15 分钟（推荐）」**（即 `900` 秒，也提供 `10 分钟` / `30 分钟` 预设）！
     *(💡 老手避坑算术题：因为自建中枢默认 `interval_sec = 300` 每 5 分钟发一封信，失联判定必须比 300 秒更长——比如推荐的 `900` 秒（15 分钟），给足 2~3 个心跳周期的容错，绝不会因为网络抖动误报；如果你非要设更短的阈值，记得把自建中枢 `hub.toml` 里的 `interval_sec` 同步改小成 `60` 秒！)*
   - **通知渠道**：勾选刚才配好的 Telegram 或 Webhook 渠道，点击 **「保存提醒设置」**！（刚保存还没收到自建机器心跳时，顶部掉线提醒状态会温和显示 **「等待首次连接」**，不会一上来就误报红色告警。）
4. 展开下面的折叠区 **「手动安装参数」**，点击复制生成的上报地址与密钥（或直接记下里面的 `--watchdog-url` 与 `--watchdog-secret`）。

#### 第三步：填进你的自建 `uniob-hub`
- **如果你正准备通过面板引导新装 `uniob-hub`**：在「面板迁移与运行模式」->「迁往其他面板」选择 **「新装一台自建服务器并搬过去」** 并点击 **「生成一键安装命令」** 时，系统会自动帮你开启掉线提醒并把云端心跳参数附带进 `install-hub.sh` 命令里，直接回服务器执行就一步到位！
- **如果你已经手动装好了 `uniob-hub`**：编辑服务器上的 `/etc/uniob-hub/hub.toml`，把 `[watchdog]` 段填上：
  ```toml
  [watchdog]
  url = "https://monitor.example.com/api/watchdog/ping"
  secret = "粘贴刚才在 CF 面板「手动安装参数」里拿到的密钥"
  interval_sec = 300
  ```
  然后重启服务（启动瞬间就会立刻寄出第一封平安信！）：
  ```bash
  sudo systemctl restart uniob-hub
  ```

等个几秒钟，回 CF Worker 面板点一下「面板迁移与运行模式」右上角的刷新状态——看到掉线提醒状态从「等待首次连接」变成绿色的 **`守护中`**，这波双保险就稳如泰山了！

---

## 6. 灵魂功能 2：CF 中枢 ↔ 自建中枢「不断联无感热迁移」

很多朋友一开始先用免费的 Cloudflare Workers 接了二三十台小鸡，后来买了台大盘鸡想切到自建 `uniob-hub`（或者反过来，自建机器到期不续费了，想把所有小鸡迁回免费的 CF Worker）。

换作别的监控面板，你得苦哈哈挨个 SSH 登进 30 台服务器改配置重启探针，配好的告警规则和当月累计跑了多少 GB 流量也全废了。

在 UniOB 里，**你连一台小鸡的 SSH 都不用登，全程在网页上点四下鼠标就搬完了！**

### 为什么能做到「免改 Token + 切坏了自动退回老家」？

1. **Token 零重发**：无论 CF 还是自建中枢，数据库里存的都是节点令牌的 `token_sha256` 指纹。导出便携状态包时，节点 ID、`token_sha256`、分组标签、Telegram 渠道、告警规则和当月流量账本（`traffic_ledgers`）全给你打包带走（还会贴心剔除旧机器专属的 `watchdog_state` 防止串台）。导入新中枢后，老探针拿着原来的令牌过来敲门，指纹严丝合缝秒通过！
2. **10 秒金丝雀试探握手（不断旧连先试新连）**：当你在旧中枢点下「热迁移」时，旧中枢会用每台小鸡独有的密钥签发一条防篡改指令（带 `±600s` 防重放与私网 SSRF 拦截）。小鸡上的探针收到后，**先不断开旧中枢连接**，而是悄悄向新中枢发起试探连接——**必须在 10 秒内收到新中枢回传的首帧 `ctrl` 确认完全握手成功**，探针才会把新地址持久化写进 `/var/lib/uniob/endpoint_override.toml` 并正式切过去！万一你新中枢域名填错了或者反代没配好，10 秒握手失败，探针安安稳稳留在旧中枢，一台都不会丢！
3. **新家塌了自动回退（`fallback_url`）**：就算搬过去几天后新中枢突然暴毙，只要探针连续重连 **超过 300 秒（5 分钟）或连续失败满 10 次**，它会自动撕掉临时改道单，乖乖连回你的 `fallback_url`（原中枢）报到！

---

### 两步实操：零断联丝滑搬家（CF → 自建 / 自建 → CF 双向完全通用！）

假设我们要把所有服务器从 **旧面板**（`https://monitor.example.com`）搬到 **新面板**（`https://hub.example.com`），新版界面已经把同步配置、安全检查和切换探针收拢成一个引导向导：

#### 场景 A：你已经搭好了目标新面板（用迁移口令 1 步搬家）
1. **在新面板生成迁移口令**：打开新面板 **「服务器管理」->「面板迁移与运行模式」**，切到 **「迁入到此面板」** 标签页，点击 **「生成迁移口令」**，复制生成的那串 `uobm1_...` 口令（30 分钟内有效，页面会自动开始等待旧面板把服务器送过来）。
2. **在旧面板一键同步并切换（强烈推荐先选 1 台试路！）**：
   - 回到旧面板的 **「面板迁移与运行模式」->「迁往其他面板」**，选择 **「已有目标面板（用迁移口令一键搬家）」**，把刚才复制的 `uobm1_...` 口令粘贴进去。
   - **好习惯**：建议先勾选 **「先用 1 台在线服务器试路，确认无误后再全部切换」**，挑 1 台非核心小鸡试水，再点 **「一键同步并切换」**！
   - 旧面板会自动帮你把服务器清单、告警规则、通知渠道与当月流量统计一并同步过去，并在 3 步实时进度条里展示迁移状态。看到新面板那边顺利多出 1 台亮绿灯的服务器，证明反代、TLS 和 Access 放行 100% 正常；取消试路勾选再点一次 **「一键同步并切换」**，几十台服务器整整齐齐秒切进新家，点击底部的 **「打开新面板」** 就能直接跳转过去！

#### 场景 B：你还没装 `uniob-hub`，准备新开一台 VPS 直接搬过去
1. 在 **旧面板** 打开 **「面板迁移与运行模式」->「迁往其他面板」**，选择 **「新装一台自建服务器并搬过去」**。
2. 第 1 步点 **「生成一键安装命令」**（若当前在 Cloudflare 云端，会自动开启「自建面板掉线提醒」并把云端心跳参数顺带写进安装命令），复制生成的 `curl ...` 命令到新 VPS 执行安装。
3. 第 2 步等新面板启动并配好域名（如 `https://hub.example.com`）后，直接把网址填进输入框，点 **「检测新面板并切换」**，看着 3 步进度条走完、点 **「打开新面板」** 就全搞定了！

*(💡 如果你在无公网互通的离线环境或想手动做冷备迁移，点开弹窗最底部的折叠区 **「备份与恢复（离线导出或导入配置文件）」** 即可导出/导入 `.json` 备份包，或在新中枢安装时用 `--import-bundle ./uniob-backup.json` 导入。)*

---

## 7. 日常包养指南（备份、升级、忘密码急救与卸载排错）

### 📦 1. 数据备份：单文件拷走就是全世界

- **轻量配置备份（推荐日常随手点）**：平时改完服务器或告警规则，在网页 **「服务器管理」->「面板迁移与运行模式」** 展开底部的 **「备份与恢复（离线导出或导入配置文件）」** 导出 `.json` 备份即可，文件只有几十 KB，除了历史曲线之外的所有家当全在里面了。
- **连同 1 年历史曲线的完整冷备**：所有数据都在 `/var/lib/uniob-hub/uniob.db` 里。因为开启了 SQLite WAL 高并发模式，热运行期间直接 `cp` 可能会漏掉 `-wal` 里的未落盘页，推荐用下面任一姿势干净备份：
  ```bash
  # 方式 A：如果装了 sqlite3 命令行，支持不停机在线热备份
  sudo sqlite3 /var/lib/uniob-hub/uniob.db ".backup '/root/uniob-backup-$(date +%F).db'"

  # 方式 B：停服务 2 秒钟让 WAL 自动归档，直接拷单文件再拉起
  sudo systemctl stop uniob-hub
  sudo cp /var/lib/uniob-hub/uniob.db "/root/uniob-backup-$(date +%F).db"
  sudo systemctl start uniob-hub
  ```

---

### 🚀 2. 无损升级 `uniob-hub` 与手下 `uniob-agent` 探针

- **升级 `uniob-hub` 自身**：发新版本了**不带任何参数**直接重跑一遍一键安装脚本就行！
  当脚本检测到 `/etc/uniob-hub/hub.toml` 已经存在且你没有传覆盖参数时，**它绝对不会动你的配置文件和 `/var/lib/uniob-hub/uniob.db` 数据库**，只会把二进制、前端网页和 `/usr/local/share/uniob-hub/releases/` 本地探针缓存更新到最新版并平滑重启：
  ```bash
  curl -fsSL https://hub.example.com/install-hub.sh | sudo bash
  ```
- **一键/自动升级手下所有 `uniob-agent` 探针（`auto_update_v1`）**：
  - 打开自建面板的 **「服务器」->「自动更新」**，即可选择 `stable`（优先读取自建中枢本地 `/usr/local/share/uniob-hub/releases/SHA256SUMS` 与 `VERSION`，缺省再兜底 GitHub Releases）、`github`（反过来以 GitHub 为主、本地文件当 `fallback_url`）或自定义镜像源 `custom_base_url`。
  - 开启自动更新或手动点击触发后，中枢会向在线 `auto_update_v1` 探针推送用各节点 `token_sha256` 签名的 `ctrl.update` 指令；探针在非特权 `nobody` 下完成下载与 `\x7fELF`/SHA-256 校验，由 `uniob-agent-update.path` 触发 root 助手复核（`--verify-staged-update`）、备份 `.prev` 并原子切换，2 秒后若服务未恢复健康则自动回退旧版。
  - *(若小鸡上是早期未带 `uniob-agent-update.path` 的旧版探针，先在小鸡重跑一次 `curl -fsSL https://hub.example.com/install.sh | sudo bash` 即可补齐更新单元，原有 `/etc/uniob/agent.toml` 与迁移状态全部保留。)*

---

### 🔑 3. 忘了内置管理员密码（`builtin` 模式）怎么自救？

人总有脑子短路忘密码的时候！只要你没在 `/etc/uniob-hub/hub.toml` 里硬编码写死 `admin_password_hash`，网页向导设的密码就存在本地 SQLite 数据库的 `system_settings` 表里。

SSH 登进你装 `uniob-hub` 的这台服务器，把密码记录删掉（连服务都不用重启！）：

```bash
# 如果系统里有 sqlite3 命令：
sudo sqlite3 /var/lib/uniob-hub/uniob.db \
  "DELETE FROM system_settings WHERE key IN ('admin_password_hash', 'session_secret');"

# 如果极简系统没装 sqlite3，用自带的 python3 一行照样秒清：
sudo python3 -c "import sqlite3; c=sqlite3.connect('/var/lib/uniob-hub/uniob.db'); c.execute(\"DELETE FROM system_settings WHERE key IN ('admin_password_hash','session_secret')\"); c.commit()"
```

敲完直接回浏览器刷新网页——久违的 **「初始化管理员密码」** 向导马上弹出来让你重设新密码！

---

### 🩺 4. 看日志排错速查表

遇到任何不对劲（比如看门狗显示超时、服务起不来），敲这一行实时看 `uniob-hub` 日志：

```bash
sudo journalctl -u uniob-hub -f
```

常见报错对号入座：
- 日志里飘过 `watchdog ping warning: Watchdog HTTP 403`：说明 CF Worker 面板那边还没在 **「自建面板掉线提醒」** 中打开 **「开启自建面板掉线提醒」** 并点击 **「保存提醒设置」**，心跳接口默认处于关闭拒收状态。
- 日志里飘过 `watchdog ping warning: Watchdog HTTP 401`：要么两边的 `secret` 粘贴不一致（注意前后别多粘空格），要么你这台自建服务器系统时间歪了超过 5 分钟（敲 `timedatectl` 检查 NTP 时间同步）。
- 日志里飘过 `watchdog ping warning: Watchdog HTTP 302`（或解析错误）：你的 CF Worker 开了 Zero Trust Access，但漏了把 `/api/watchdog/ping` 加进 `Bypass` 放行列表！
- 小鸡连自建中枢报 `426 Upgrade Required`：你用的 Nginx 反代漏抄了第 3 节里的 `proxy_http_version 1.1`、`Upgrade` 和 `Connection` 三件套。

---

### 🧹 5. 彻底干净卸载

如果这台机器不再做中枢了（**⚠️ 警告：卸载会一并删除 `/var/lib/uniob-hub/uniob.db` 数据库！如果上面还连着探针，请务必先按第 6 节把服务器热迁移走，并在「备份与恢复」中下载配置文件备份！**）：

```bash
curl -fsSL https://hub.example.com/install-hub.sh | sudo bash -s -- --uninstall
```

一行命令自动停用 `uniob-hub.service`，并将二进制、配置文件、前端资源和数据库目录清理得一尘不染。
