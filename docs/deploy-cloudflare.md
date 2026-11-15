# Cloudflare Workers 边缘中枢从零部署教程（人话版）

> **一句话定位**：不想专门买一台服务器挂监控面板？不想操心面板机续费、硬盘坏道、SSL 证书过期或者被人拿 DDoS 打死？这篇教程手把手带你用 **15 分钟** 把 UniOB 塞进 Cloudflare 的全球边缘网络里，管好你手头几十台 Linux 小鸡（哪怕是 512M/1G 内存的丐版 VPS 也能轻松带，探针常驻内存才 `3~6 MB`）。
>
> 💡 *如果你手里有一台常年开机的闲置 VPS，想 24 小时挂着大屏看 1 秒级实时曲线且完全不想算计云端配额，也可以直接看姊妹篇 👉 [《自部署 `uniob-hub` 独立中枢 + CF 看门狗与无感热迁移教程（人话版）》](./deploy-self-hosted.md)，或者先搭好本文的免费 CF 中枢，日后随时一键热迁移过去！*

---

## 1. 先说人话：用 Cloudflare 当监控中枢，真的不花一分钱吗？

很多老玩家一听「把监控面板装在 Cloudflare Workers 上」，第一反应都是摇头：**「拉倒吧！之前试过别的面板，挂十来台小鸡跑半天就把 CF 每天的免费读写额度刷爆了，下午直接报错罢工！」**

这话一点不假——传统的云端监控做法是「每台小鸡开一个独立实例、每秒钟往数据库里硬塞一条记录」，免费额度神仙也扛不住。

UniOB 之所以敢让你放心白嫖，是因为它在底层搞了一套叫 **SCCH（同址收敛休眠中枢 / `FleetHubDO`）** 的省钱绝活。把它翻译成人话就是：

> **所有小鸡和你的浏览器，全都住进同一个自带本地小账本的值班室（单个 `FleetHubDO` 实例）里。**
>
> - **平时你不看网页时（省电模式）**：值班室直接关灯睡觉（WebSocket Hibernation 休眠期间不收内存驻留费），所有小鸡上的探针自动退回「静默档」——自己先在内存里记账，**每 5 分钟才凑齐一沓递一次打包小纸条（`mb` 批量帧）**。
> - **半夜机器出事了会耽误报警吗？绝对不会！** 探针脑子里记着你的告警水位线。哪怕在 5 分钟静默期里，只要某台机器 CPU 突然暴涨（单次跳变 `>= 35%`）、内存/硬盘越过红线或者刚发生重启，探针会**当场踹门秒发紧急帧**，告警延迟照样是 **0 秒**！
> - **当你打开网页看盘时（直播模式）**：值班室瞬间开灯，通知小鸡切回秒级实时上报，让你丝滑看曲线、查进程；等你关掉网页（或者挂着标签页 **超过 10 分钟没动鼠标**），前端会自动发指令让探针缩回 5 分钟一报的省电模式。

### 算笔明白账：免费档（Free） vs $5 付费档（Paid）怎么选？

| 对比项 | Workers Free（$0/月 纯白嫖档） | Workers Paid（$5/月 省心档） |
| :--- | :--- | :--- |
| **核心卡脖子指标** | Durable Objects SQLite 每天免费写入 **`100,000` 行** | 每月基础费 `$5`，包含海量读写配额 |
| **纯后台挂机等告警** | 稳带 **~112 台** 小鸡 | 几百台随便塞 |
| **正常使用（每天打开看盘约 2 小时）** | 稳带 **~75 台** 小鸡 | 200 台机器全天候跑也才约 **`$5.24/月`** |
| **24×7 全天挂着大屏盯秒级曲线** | 约 **~16 台** 就会触顶当天免费上限 | 毫无压力 |

**给你的实在建议**：
- 手里 `3 ~ 50` 台小鸡的个人玩家，**直接用免费的 Workers Free 就够了，一分钱不用掏！**
- ⚠️ **白嫖党唯一要守的规矩**：看完面板顺手关标签页（或者切到别的标签页），**千万别在电脑上开十几个监控标签页 24 小时亮屏死盯着秒级刷新**——只要有人盯着实时画面，所有小鸡就得陪着高频干活，免费额度自然掉得快。如果你就是喜欢副屏 24 小时挂着监控墙看秒级跳动，要么花 `$5/月` 升 Paid，要么用 [自建 `uniob-hub`](./deploy-self-hosted.md) 扛日常、留着免费 CF 当失联报警器！

---

## 2. 开工前准备 3 样东西

动手前花 3 分钟清点一下家伙什，少一样后面都会卡壳：

### 准备 ①：一个已经托管在 Cloudflare 的域名
假设你的域名是 `example.com`，我们打算用 `monitor.example.com` 当监控面板地址。
- **不用提前去 DNS 页面手动加 A 记录或 CNAME！** 待会儿部署时，Wrangler 看到 `custom_domain: true` 会自动帮你挂好路由并签发 HTTPS 证书。
- *(如果该子域名以前绑过别的机器 A 记录，先去 CF DNS 里把旧记录删掉，免得冲突报错。)*

### 准备 ②：你手头的电脑装好 `Node.js >= 20` 和 `git`
Windows（PowerShell）、macOS 或 Linux 电脑都能操作，敲 `node -v` 确认大版本号 `>= 20` 即可。

> 💡 **重大省心提示：你完全不需要装 Rust 编译环境！**
> 被控端安装脚本（`/install.sh`）默认会优先从同源 `/releases/...` 拉取静态二进制，找不到时会自动兜底从 `GITHUB_REPO`（默认 `Cusnd/UniOB`）的 **GitHub Releases** 拉取预编译好的 Linux 纯静态二进制（含 `x86_64` 与 `aarch64` 双架构 `uniob-agent`、`uniob-hub` 及 `SHA256SUMS`）。
> 如果你想连边缘也托管一份二进制副本（加速国内/纯静态环境访问），可以从 GitHub Releases 下载对应产物放入 `web/public/releases/` 后再构建前端，或在运行 `.github/workflows/deploy-cloudflare.yml` 时由流水线自动拉取最新 GitHub Release 产物打入边缘静态资源。

### 准备 ③：拉取代码、装依赖并登录 Cloudflare

打开你的电脑终端，依次执行下面几行。
⚠️ **老手防坑提醒**：UniOB 根目录的 `package.json` 只是个快捷命令入口，**没有启用 npm workspaces**，前端（`web/`）和后端（`worker/`）各自独立管理依赖。如果你只在根目录敲一下 `npm install`，其实啥依赖都没装上！请务必照着下面两行 `--prefix` 装齐：

```bash
# 1. 克隆仓库并进入目录
git clone https://github.com/Cusnd/UniOB.git
cd UniOB

# 2. 分别安装前端与 Worker 的依赖（这两步千万别省！）
npm --prefix web install
npm --prefix worker install

# 3. 登录你的 Cloudflare 账号（会自动弹浏览器，点 Allow 授权即可）
npx --prefix worker wrangler login
```

---

## 3. 五步把边缘中枢跑起来

准备就绪，下面五步全程复制粘贴，5 分钟就能看到面板上线！

### 第一步：创建云端 D1 数据库

D1 是 Cloudflare 的 Serverless SQLite 数据库，UniOB 用它存你的节点清单、Token 指纹、Telegram 告警渠道和告警历史（高频监控曲线不写这儿，写前面说的 `FleetHubDO` 环形库里，所以 D1 额度极其充裕）：

```bash
npx --prefix worker wrangler d1 create uniob-meta
```

命令跑完后，终端会吐出类似下面这样一段提示，**把里面的 `database_id`（那串 UUID）复制下来**：

```jsonc
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "uniob-meta",
      "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" // <--- 复制这串 ID！
    }
  ]
}
```
*(如果你以前建过同名库提示已存在，敲 `npx --prefix worker wrangler d1 list` 就能把它的 UUID 查出来。)*

---

### 第二步：修改 `worker/wrangler.jsonc` 配置文件（必改！漏改必报错）

> 🚨 **敲黑板**：仓库里的 `worker/wrangler.jsonc` 默认填的是全零占位 `database_id`（`00000000-0000-0000-0000-000000000000`），默认开启 `"workers_dev": true` 和内置密码登录（`AUTH_MODE = "builtin"`）。**必须先把 `database_id` 替换成你自己的 D1 数据库 UUID 再部署！**

用编辑器打开 `worker/wrangler.jsonc`，按你的需求检查下面几处：

1. **`d1_databases[0].database_id`**（必填）：把占位的 `00000000-0000-0000-0000-000000000000` 替换成第一步拿到的真实 `database_id`。
2. **`account_id`**（多账号环境可选）：如果 Cloudflare 账号下有多个工作区，取消注释并填入你自己的 Account ID；单工作区账号留空即可由 Wrangler 自动识别。
3. **`routes` / `workers_dev`**（可选自定义域名）：开箱即用可保留 `"workers_dev": true`；绑定自定义域名时改为 `"workers_dev": false` 并取消注释 `"routes"`（如 `"monitor.example.com"`）。
4. **`vars`（管理员登录模式：内置密码 vs Zero Trust Access）**：

> 💡 **更懒的自动化方案**：你也可以使用仓库自带的 [.github/workflows/deploy-cloudflare.yml](../.github/workflows/deploy-cloudflare.yml)，在 GitHub Repo Settings 配置 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` 与 `CF_D1_DATABASE_ID` 后，直接在 GitHub Actions 页面点击触发部署（无需在本地反复修改 `wrangler.jsonc`）。

#### 姿势 A：新手 3 分钟最快尝鲜 —— 内置密码登录（`AUTH_MODE = "builtin"`，仓库默认）
不想先去折腾 Zero Trust？保持默认 `"AUTH_MODE": "builtin"` 即可！部署完第一次打开网页，会自动弹出向导让你设一个管理员密码（最少 6 位，自动用 10 万次 PBKDF2 加盐哈希存进数据库；连续输错 5 次自动封禁该 IP 5 分钟防爆破）：

```jsonc
  // 如果还没绑定自定义域名，保持 workers_dev 为 true 即可先通过 *.workers.dev 访问
  "workers_dev": false,
  "preview_urls": false,
  "routes": [
    {
      "pattern": "monitor.example.com",
      "custom_domain": true
    }
  ],
  "vars": {
    "AUTH_MODE": "builtin",
    "GITHUB_REPO": "Cusnd/UniOB"
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "uniob-meta",
      "database_id": "粘贴你第一步拿到的-database-id"
    }
  ],
```
*(防抢注小贴士：如果你怕刚部署好那几秒钟被路人先打开网页设了密码，也可以提前生成密码哈希塞进环境变量：`printf '%s' '你的强密码' | sha256sum | awk '{print $1}'`，然后跑 `npx --prefix worker wrangler secret put ADMIN_PASSWORD_HASH` 把算出来的 64 位哈希粘进去。)*

#### 姿势 B：生产环境强烈推荐 —— Cloudflare Zero Trust 邮箱验证码大门（`AUTH_MODE = "cf_access"`）
Cloudflare Zero Trust 免费计划白送 **50 个用户席位**！开启后，任何陌生人访问你的监控域名，在 Cloudflare 边缘大门口就会被拦下要求输入白名单邮箱收一次性验证码（One-Time PIN），连你的 Worker 都摸不到；进门后 Worker 代码还会二次校验 RS256 签名和邮箱白名单（双层防弹衣）：

```jsonc
  // 用 cf_access 时务必保持 workers_dev 为 false！否则别人能从 xxx.workers.dev 绕过你的域名大门！
  "workers_dev": false,
  "preview_urls": false,
  "routes": [
    {
      "pattern": "monitor.example.com",
      "custom_domain": true
    }
  ],
  "vars": {
    "AUTH_MODE": "cf_access",
    "CF_ACCESS_TEAM_DOMAIN": "你的团队名.cloudflareaccess.com",
    "CF_ACCESS_AUD": "第 4 节建好 Access 应用后拿到的 AUD 字符串",
    "CF_ACCESS_ALLOWED_EMAILS": "admin@example.com" // 多个邮箱用英文逗号隔开
  },
```
*(💡 实用建议：如果你还没配过 Zero Trust，可以先按姿势 A 填 `"AUTH_MODE": "builtin"` 把下面三步跑通，亲眼看到网页跑起来了，再跟着第 4 节花 3 分钟把 Zero Trust 锁加上！)*

---

### 第三步：往云端 D1 建表（执行数据库迁移）

在项目根目录执行下面这行命令，把表结构刷进云端数据库：

```bash
cd worker && npx wrangler d1 migrations apply uniob-meta --remote && cd ..
```

> ⚠️ **千万别漏掉尾巴上的 `--remote`！**
> 不带 `--remote` 的话，Wrangler 只会在你电脑本地建个模拟库，云端数据库里一张表都没有——等你打开线上网页直接给你甩一脸 `500 Internal Server Error (no such table)`！
> 终端问你确认时输入 `y` 回车，看到 `0001_init.sql` 后面打上绿勾就妥了。

---

### 第四步：构建前端网页（顺带打包静态探针）

回到项目根目录执行：

```bash
npm run build:web
```

构建完成后，你可以顺手瞄一眼生成的 `web/dist/releases/` 目录——里面应该整整齐齐躺着 `uniob-agent-x86_64-unknown-linux-musl`、`uniob-agent-aarch64-unknown-linux-musl`、`uniob-hub-*`、`uniob-web-dist.tar.gz` 和 `SHA256SUMS`。有它们随前端静态资源一块上云，以后你的小鸡装探针时直接从你自己的 CF 域名满速拉二进制，就算遇到连不上 GitHub 的国内机或纯 IPv6 小鸡也照装不误！

---

### 第五步：一键部署上云！

```bash
cd worker && npx wrangler deploy && cd ..
```

看到终端打印出 `Published uniob`、绑好你的自定义域名 `monitor.example.com` 并挂载了 `schedule: */5 * * * *` 定时触发器，你的全球边缘监控中枢就正式营业了！

- 如果你前面选的是 **`builtin` 内置密码模式**：现在直接打开 `https://monitor.example.com` 设置管理员密码，跳去 **第 5 节** 接小鸡就行！
- 如果你准备上最稳的 **`cf_access` 零信任保护**：**先别急着装探针！请一定、务必把紧接着的第 4 节看完，否则你的探针 100% 连不上！**

---

## 4. 90% 的人第一次必踩的大坑：Cloudflare Zero Trust Access 怎么给探针留后门（Bypass）？

### 先用大白话讲明白：为什么别人一开 Zero Trust，探针就全瞎了？

想象一下：你给 `monitor.example.com` 装了一道「刷脸+收邮件验证码」的防盗门（Cloudflare Access）。你用电脑浏览器访问，弹框填邮箱、收个 6 位数字验证码，滴一声开门进去了，体验满分。

**但你的 Linux 服务器是个黑框框啊！它不会打开邮箱收验证码！**

当你在小鸡 SSH 里敲 `curl -fsSL https://monitor.example.com/install.sh` 拉安装脚本，或者小鸡上的 `uniob-agent` 后台服务去连 `wss://monitor.example.com/api/agent/ws` 交作业时，防盗门一看：「哟，没带登录 Cookie？」——啪一下甩回一个 **`HTTP 302 Found` 重定向**，把你的探针一脚踢去 `xxx.cloudflareaccess.com` 的 HTML 登录网页！

结果就是：
- 拉安装脚本时，直接报错或者啥也没反应（因为 `curl` 拿到的是登录页 HTML 而不是 Shell 脚本）；
- 就算探针装上了，面板上永远灰着显示 **「离线」**！

### 正确解法：在 Zero Trust 里建「两个」应用——前门查邮箱，侧门验暗号！

Cloudflare Access 有个非常好用的特性：**路径越具体，匹配优先级越高（最长前缀匹配优先）**。我们只需要建两个应用：一个管整站大门（只放你本人进），另一个专门把给机器走的 **5 条路径** 设为 `Bypass`（跳过邮箱登录，直接交给 Worker 代码里的密钥签名去严查）。

打开 [Cloudflare Zero Trust 控制台](https://one.dash.cloudflare.com/)（第一次进如果让你起 Team Name 团队名，随便起个英文名比如 `myops`，记下你的团队域名 `myops.cloudflareaccess.com`；选 **Free `$0` 计划** 即可），在左侧菜单进入 **Access -> Applications**（新版界面也可能叫 **Access controls -> Applications**）：

---

#### 🏠 第 1 个应用：管理控制台大门（保护整站）

1. 点击 **Add an application** -> 选择 **Self-hosted**。
2. **Application name**：随便填，比如 `UniOB Dashboard`。
3. **Public hostname**（添加公开主机名）：
   - **Subdomain**：`monitor`
   - **Domain**：`example.com`
   - **Path**：**留空不填！**（代表默认保护 `monitor.example.com` 整站所有页面和 API）。
4. 进入下一步添加 **Policy（访问策略）**：
   - **Policy name**：`Allow Admin`
   - **Action（动作）**：选 **`Allow`**
   - **Configure rules -> Include**：Selector 选 **`Emails`**，右边填你自己的邮箱（如 `admin@example.com`）。
5. 一路点 Next / Save 保存应用。
6. 保存后重新点进这个应用的详情页（Overview），找到 **Application Audience (AUD) Tag**，点复制那一长串 64 位字符。
7. 回到本地打开 `worker/wrangler.jsonc`，确认 `"workers_dev": false`，把 `"vars"` 填好：
   ```jsonc
   "vars": {
     "AUTH_MODE": "cf_access",
     "CF_ACCESS_TEAM_DOMAIN": "你的团队名.cloudflareaccess.com",
     "CF_ACCESS_AUD": "粘贴刚才复制的那长串 AUD",
     "CF_ACCESS_ALLOWED_EMAILS": "admin@example.com"
   }
   ```
   然后重新推一次部署让配置生效：
   ```bash
   cd worker && npx wrangler deploy && cd ..
   ```

---

#### 🚪 第 2 个应用：探针与机器专用侧门（Action = Bypass，5 条路径一条别漏！）

再次点击 **Add an application** -> 选择 **Self-hosted**：

1. **Application name**：填 `UniOB Machine Bypass`。
2. **Public hostnames**：点击 **Add public hostname**，把下面表格里的 **5 条路径逐一添加进去**（Subdomain 全填 `monitor`，Domain 全选 `example.com`）：

| 序号 | Path（精确照抄，注意斜杠和星号） | 这条路是干啥的？跳过邮箱验证安全吗？ |
| :---: | :--- | :--- |
| **1** | `/api/agent/ws` | **探针 WebSocket 上报专线**。绝对安全：请求一进 Worker 就必须过 `X-UniOB-Node-Id` + `Authorization: Bearer uob_live_...` 哈希比对，没真令牌直接吃 `401` 闭门羹！ |
| **2** | `/install.sh` | **被控小鸡的一键安装脚本**。纯公开的 Bash 安装器，里面没有任何密码或节点 Token，放心放行。 |
| **3** | `/install-hub.sh` | **自建中枢 `uniob-hub` 的一键安装脚本**。日后你想一键搭自建中枢时直接 `curl` 拉取，同样不含敏感信息。 |
| **4** | `/releases/*` | **预编译静态二进制包与 `SHA256SUMS`**（注意末尾必须带 `/*`！）。放行后小鸡装探针或搭自建中枢时，能直接从你的 CF 边缘节点高速下载二进制并做哈希校验。 |
| **5** | `/api/watchdog/ping` | **自建面板「云端掉线提醒」心跳接口**。绝对安全：强制核验 `X-Watchdog-Timestamp`（`±300` 秒防重放时间窗）与 `HMAC-SHA256` 签名，伪造请求一律 `401`。 |

3. 进入下一步添加 **Policy（策略 —— 90% 翻车都在这一步选错！）**：
   - **Policy name**：`Bypass Machine Endpoints`
   - **Action（动作）**：必须选 **`Bypass`**（或者中文界面的「绕过」，**千万别顺手选成 Allow！**）
   - **Configure rules -> Include**：Selector 选 **`Everyone`**（勾上所有人！选 Bypass 时只有配 Everyone 才能让无登录态的 Linux 小鸡直接通行）。
4. 点击保存！

---

#### 🔍 花 10 秒钟自检你的侧门通没通

随便在终端敲下面两条 `curl`（不用带任何密码或 Cookie），结果对得上就说明你一次配成了：

```bash
# 测试 1：拉取安装脚本头信息 —— 必须看到 HTTP/2 200！
# （如果看到 HTTP/2 302 且 location 指向 cloudflareaccess.com，说明 Bypass 没命中！）
curl -I https://monitor.example.com/install.sh

# 测试 2：裸敲探针 WebSocket 接口 —— 必须看到 426 Upgrade Required！
# （看到 426 说明请求已经顺利穿过 CF Access 大门到达了你的 Worker 代码！绝不能是 302！）
curl -i https://monitor.example.com/api/agent/ws
```

---

## 5. 接入第一台小鸡 & 绑好 Telegram 机器人告警

最难的关已经过了，下面就是享受成果的时刻！

### 第一步：在面板新建节点，拿到一键安装命令

1. 用浏览器打开 `https://monitor.example.com`，验证身份进入 UniOB 控制台。
2. 切换到 **「服务器管理」** 页面，点击 **「添加服务器」**：
   - **服务器名称**：起个顺眼的名字，比如 `东京主力机` 或 `DMIT-LAX`。
   - **分组与标签**：默认 `Default` 即可，机器多了可以按地区/用途分组。
   - **月流量配额（可选但巨好用）**：比如你这台 VPS 每月限 `1000` GB 流量、每月 `1` 号重置、商家按「双向计费」还是「仅算上传」统计，填进去后首页卡片就能直观看到流量条和超额预警！
3. 点击保存后，界面会立刻弹出一串 **为你这台小鸡量身定制的一键安装命令**：

```bash
curl -fsSL https://monitor.example.com/install.sh | sudo bash -s -- \
  --url wss://monitor.example.com \
  --id node_xxx \
  --token uob_live_xxx
```

> 🔐 **安全小细节**：这串 `uob_live_...` 明文令牌 **只在新建或重置时显示这一次**，云端数据库里只存它的 SHA-256 哈希值。万一关太快没存下来也不用慌，在「服务器管理」列表里点一下钥匙图标（重置连接密钥），立马就能生成一条新的安装命令！

### 第二步：SSH 连上小鸡粘贴执行，坐等亮绿灯！

SSH 登录你的 Linux 服务器（支持主流 Debian / Ubuntu / CentOS / Rocky / Alpine 等所有带 `systemd` 的 `x86_64` 或 `aarch64` 系统），把刚才复制的命令直接粘贴回车！
*(注：如果你当前就是 `root` 用户登录，且极简系统里没装 `sudo` 命令，把管道符后面的 `sudo ` 删掉变成 `| bash -s -- ...` 即可。)*

脚本会在几秒钟内自动完成：
1. 从你的域名 `/releases/` 下载对应架构的纯静态 `uniob-agent`（不到 2 MB）并核对 `SHA256SUMS`；
2. 写入 `/etc/uniob/agent.toml`（权限 `0640` 严格保密 Token）；
3. 注册并启动 `uniob-agent.service`（以无特权的 `nobody` 用户运行，自带 `MemoryMax=24M` 硬上限护栏，绝不挤占你跑业务的内存！）。

看到终端打印 `[uniob-install] uniob-agent installed and started successfully.`，切回浏览器面板——**3 秒之内，圆点变绿，CPU 型号、系统内核、硬盘占用和实时上下行网速唰地一下全出来了！**

*(进阶小开关：如果你某台机器跑着高度机密业务，不想在网页上按需查看进程列表，可以在安装命令末尾加个 `--disable-proc` 物理锁死进程采集；或者加 `--cmdline comm_only` 只报进程名、隐藏一切命令行参数。)*

### 第三步：3 分钟配好 Telegram 实时告警

监控不配告警，等于买保险不留电话号码：

1. **建个 TG 机器人拿 Token**：在 Telegram 搜索官方 `@BotFather`，发送 `/newbot`，按提示起名后拿到一串形如 `123456789:AAHxxx...` 的 **Bot Token**。**建好后记得先点进你自己的机器人点一下 Start（发一句 `/start`）**，否则 Telegram 不允许机器人主动给你发私信！
2. **查出你的 Chat ID**：在 Telegram 搜索 `@userinfobot` 发任意消息，它会回复你的纯数字 `Id`（如果你是把机器人拉进运维群组，群组 Chat ID 通常是 `-100` 开头的负数；如果群开了话题 Topics，还可以记下对应话题的 Thread ID）。
3. **去面板绑定并实测**：
   - 在 UniOB 网页切到 **「告警通知」** 页面。
   - 在 **通知渠道** 区域点新建，类型选 **Telegram**，填好名称、**Bot Token** 和 **Chat ID**（可选填 Thread ID），点击保存。
   - 点渠道右侧的 **发送测试（小纸飞机图标）** —— 手机「叮咚」弹出测试消息，通路就彻底打通了！
4. **添加告警规则**：
   - 在下方 **告警规则** 区域新建规则（服务器选「所有服务器」即可一劳永逸管所有机器）：
     - 必配推荐 1：**服务器离线时长** `>` `2 分钟`（`120` 秒，小鸡宕机拔线 2 分钟立刻喊你）
     - 必配推荐 2：**处理器占用** `>` `90%` 持续 `3 分钟`（`180` 秒）/ **磁盘空间占用** `>` `85%`
     - 必配推荐 3：**月流量使用率** `>` `85%`（防止超流量被天价扣费或停机）
   - 勾选刚才建好的 Telegram 渠道保存，从此安心睡大觉！

---

## 6. 翻车急救包（FAQ）

### Q1：小鸡跑完一键脚本没报错，为什么面板上一直灰着显示「离线」？

千万别靠猜！直接在小鸡 SSH 里敲下面这行命令，实时盯着探针的运行日志：

```bash
sudo journalctl -u uniob-agent -f
```

看日志里报错的 **HTTP 三位数字状态码**，一秒破案：

- **看到 `302`（Found / Redirect）**：
  **破案**：100% 是第 4 节的 **Cloudflare Zero Trust Access 没放行 `/api/agent/ws`**（或者你把策略的 Action 手滑选成了 `Allow` 而不是 `Bypass`，又或者漏勾了 `Everyone`）。回 Zero Trust 后台改好保存，不用重启探针，几秒钟自己就连上变绿了！
- **看到 `401`（Unauthorized）**：
  **破案**：小鸡本地 `/etc/uniob/agent.toml` 里的 `--id` 或 `--token` 跟云端数据库对不上（比如你在面板删掉重建过这台服务器，或者之前执行 D1 迁移时漏写了 `--remote`）。去面板「服务器管理」找到对应服务器点 **钥匙图标（重置连接密钥）**，复制新弹出的一键安装命令回小鸡重跑一遍即可覆盖修复。
- **看到 `426`（Upgrade Required）**：
  **破案**：WebSocket 握手头在半路丢了。去 Cloudflare 域名控制台 -> **Network（网络）**，确认 **WebSockets** 开关处于开启状态（默认是开的）。
- **看到 TLS 证书报错或一直超时重连**：
  **破案**：先在小鸡上敲 `timedatectl` 看一眼系统时间是不是歪了好几个小时甚至好几年（时间不对 TLS 握手必败）；再敲 `curl -Iv https://monitor.example.com/install.sh` 看看小鸡能不能正常完成 443 端口 TLS 握手并拿到 `200 OK`。

---

### Q2：以后 UniOB 更新版本了，怎么无损升级中枢和探针？

- **升级 Cloudflare 边缘中枢**（节点数据、历史指标和告警规则全保留）：
  ```bash
  git pull
  npm --prefix web install
  npm --prefix worker install
  npm run build:web
  cd worker && npx wrangler d1 migrations apply uniob-meta --remote && npx wrangler deploy && cd ..
  ```
- **升级小鸡上的 `uniob-agent` 探针**（超级省心：**不用再传 `--url` / `--id` / `--token`！**）：
  当安装脚本发现 `/etc/uniob/agent.toml` 已经存在时，不带参数执行会**完整保留原有配置与热迁移记录**，只把二进制平滑换成最新版并重启服务：
  ```bash
  curl -fsSL https://monitor.example.com/install.sh | sudo bash
  ```

---

### Q3：某台小鸡到期不玩了，怎么彻底卸载干净不留垃圾？

在小鸡上跑这一行，自动停掉服务，并把二进制（`/usr/local/bin/uniob-agent`）、配置目录（`/etc/uniob`）、状态目录（`/var/lib/uniob`）和 systemd 单元文件删得干干净净：

```bash
curl -fsSL https://monitor.example.com/install.sh | sudo bash -s -- --uninstall
```
卸完再去网页「服务器管理」里点垃圾桶把这台服务器删掉即可。

---

### Q4：我用的是 `builtin` 内置密码模式，把网页登录密码给忘了怎么办？

只要你没用 `wrangler secret put ADMIN_PASSWORD_HASH` 写死环境变量，密码哈希就存在云端 D1 的 `system_settings` 表里。在你的电脑终端进入项目目录执行下面这行，把旧密码和旧会话清掉：

```bash
npx --prefix worker wrangler d1 execute uniob-meta --remote \
  --command "DELETE FROM system_settings WHERE key IN ('admin_password_hash', 'session_secret');"
```
跑完刷新浏览器网页，熟悉的「首次设置管理员密码」向导就又回来啦！

---

### 附录：如果我自己改了 Rust 源码，怎么重编静态探针塞进边缘静态资源？

*(普通用户请直接跳过本段！安装脚本默认会自动从 GitHub Releases 下载对应架构二进制，只有在你想自己修改源码并重编同源镜像时才需要。)*
如果你修改了 `agent/` 或 `hub/` 下的 Rust 代码，可以在装有 Rust、`zig` 和 `cargo-zigbuild` 的机器上交叉编译零依赖 `musl` 静态包，并放入本地已 gitignore 的 `web/public/releases/`：

```bash
rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl

# 交叉编译双架构探针
cargo zigbuild --manifest-path agent/Cargo.toml --release --target x86_64-unknown-linux-musl
cargo zigbuild --manifest-path agent/Cargo.toml --release --target aarch64-unknown-linux-musl

# 放入前端静态发布目录（已被 .gitignore 忽略）并生成 SHA256SUMS
mkdir -p web/public/releases
cp agent/target/x86_64-unknown-linux-musl/release/uniob-agent web/public/releases/uniob-agent-x86_64-unknown-linux-musl
cp agent/target/aarch64-unknown-linux-musl/release/uniob-agent web/public/releases/uniob-agent-aarch64-unknown-linux-musl
(cd web/public/releases && sha256sum uniob-* > SHA256SUMS)
```
之后重新执行 `npm run build:web` 和 `npx --prefix worker wrangler deploy` 即可把你自制的探针分发到全球边缘！
