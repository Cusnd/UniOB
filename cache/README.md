# UniOB HTML 原型

五张参考图各对应一个独立 HTML 文件，由五个独立的 Astra / Max 子代理制作。没有采用 Frontend Design 或 Product Design 技能来实施。

| 参考图 | 文件 | 内容 |
| --- | --- | --- |
| 1 | [01-watermarks.html](01-watermarks.html) | 节点阈值、恢复迟滞、配置应用 |
| 2 | [02-healthy-node.html](02-healthy-node.html) | 东京节点、实时模拟、遥测和进程 |
| 3 | [03-fleet-summary.html](03-fleet-summary.html) | 全网摘要、节点筛选和告警 |
| 4 | [04-scch-hub.html](04-scch-hub.html) | SCCH 架构、容量场景和配额 |
| 5 | [05-alert-node.html](05-alert-node.html) | 新加坡告警节点、遥测和进程 |

打开 `index.html` 可切换五个原型，也可分别打开 HTML 文件。CSS 和 JavaScript 均内嵌，页面无需安装依赖。

本地预览：

```powershell
node D:\Documents\ChatGPT\UniOB\cache\serve.cjs
```

入口：<http://127.0.0.1:5175/cache/>

所有数据、告警、下发、确认和场景交互均为本地演示。页面不会修改实际服务器配置；配额及容量数值沿用参考图，并非实时服务配额查询。

`previews/` 保存浏览器渲染截图。
