# CS2 赛事实时看板

[![Deploy to GitHub Pages](https://github.com/1rgg/CS2-events/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/1rgg/CS2-events/actions/workflows/deploy-pages.yml)

查看 CS2 热门赛事的静态网站：全年赛历、当日对阵与逐图比分、时间范围筛选。纯前端 + 一个零依赖的 Node 数据代理。

> **在线版**：<https://1rgg.github.io/CS2-events/> —— 托管版只有静态赛历（见下方「托管版 vs 本地版」）。
> 想要实时数据与逐场比分，请按下面的方式在本地运行。

## 托管版 vs 本地版

| | 在线版（GitHub Pages） | 本地版（`node server.js`） |
|---|---|---|
| 全年赛历 | ✅ 用仓库里烘焙的快照 | ✅ 每 30 分钟从 Liquipedia 刷新 |
| 年度时间轴 / 筛选 / `.ics` 导出 | ✅ | ✅ |
| 当日对阵与逐图比分 | ❌ 跑不了 Node 代理 | ✅ |
| 数据新鲜度 | 流水线每天尝试刷新两次 | 准实时 |

原因是 GitHub Pages 只能托管静态文件，跑不了服务端的代理（而 Liquipedia 不返回 CORS 头，浏览器无法直连）。托管版会自动识别环境并在界面上如实标注「静态快照 · 托管版」。

## 快速开始（本地版）

```bash
git clone https://github.com/1rgg/CS2-events.git
cd CS2-events
node server.js
```

打开 <http://localhost:5173>。无需 `npm install`，零第三方依赖，Node 18+ 即可。

> 也可以直接双击 `index.html` —— 会回落到内置快照，赛历功能完整，但没有逐场数据与自动更新。

## 部署

仓库已配置 GitHub Pages 的 Actions 流水线（`.github/workflows/deploy-pages.yml`）：

1. **检出** → `actions/checkout`
2. **跑测试** → `node tools/parser-test.js` + `node tools/smoke-test.js`（任一失败即阻断部署）
3. **刷新快照** → `node tools/build-snapshot.js`（best-effort，失败不阻断）
4. **组装站点** → 只把 `index.html`、`assets/`、`data/`、`calendar.html` 复制到 `_site/`
5. **部署** → `actions/upload-pages-artifact` + `actions/deploy-pages`

触发方式：推送到 `main`、每天两次定时（`17 1,13 * * *`）、或手动 `workflow_dispatch`。

> Pages 的 Source 必须设为 **GitHub Actions**（不是「Deploy from a branch」），否则流水线不会接管。


## 功能

**年度时间轴**
一条覆盖全年 12 个月的横向时间轴，每场赛事一个色条（Major 金色、中国/中国香港/新加坡站绿色），带今天标记。点击色条跳转到对应赛事，点击月份刻度筛选当月。

**当日比赛**
按赛事分组展示对阵：开赛时间（按你的本地时区渲染）、双方队伍、系列赛比分、逐图比分（含加时）、Bo 制与进行状态。已结束的比赛会标注每张图的胜方。

**时间筛选**
「全部 / 今天 / 未来 7 天 / 未来 30 天 / 本月 / 未来 90 天 / 自定义区间」。筛选同时作用于赛历列表和比赛面板；超过 21 天时比赛面板会给出提示而不是拉取数据。

**其他**
- 指标卡：正在进行 / 30 天内开赛 / 本赛季剩余 / 零时差赛事
- 类型筛选：全部 / 仅 Major / 零时差站 / 未开始 / 已结束
- 主办方筛选：ESL / BLAST / PGL / StarLadder / 其他
- 一键导出未结束赛事为 `.ics`，可导入 Google 日历、Apple 日历或 Outlook
- 60 秒自动轮询，切回前台立即刷新，跨天与开赛时状态自动翻转
- 自动适配深色模式

## 数据是怎么来的

三层结构，任何一层失效网站都还能用：

| 层级 | 来源 | 说明 |
|---|---|---|
| 实时（赛历） | `/api/live` → Liquipedia 的 `S-Tier Tournaments/Post 2023` | 解析其中的赛事时间轴，得到全部赛事的起止日期。1 次请求 / 30 分钟。 |
| 实时（逐场） | `/api/matches` → 各赛事的阶段子页面 | 解析 `{{Match}}` 模板，取出对阵、时间、逐图比分。批量请求 + 6 小时磁盘缓存。 |
| 兜底 | `data/tournaments.json` | 内置快照，含奖金、冠亚军、场馆、备注。断网或 `file://` 打开时使用。 |

### 为什么需要 Node 代理

Liquipedia 的 `api.php` **不返回 `Access-Control-Allow-Origin`**，浏览器直连会被 CORS 拦截；其接口条款同时要求使用可识别的 User-Agent，而浏览器不允许自定义这个请求头。所以实时数据必须经服务端转发。

## ⚠️ 关于 Liquipedia 的访问限制（重要）

Liquipedia **明确不欢迎爬虫式访问**。开发过程中，为校验 35 个赛事页面而做的连续请求触发过它的 IP 临时封禁，页面返回：

> Rate Limited — Your IP address has been temporarily blocked from accessing Liquipedia due to excessive or invalid requests. Scrapers and similar tools are not permitted to access Liquipedia.

因此本项目做了四层节制：

| 措施 | 默认值 | 说明 |
|---|---|---|
| 全局最小请求间隔 | 3 秒 | 所有请求串行排队，不会并发 |
| 429 全局冷却 | 30 分钟 | 一旦被限流立刻停止所有请求，前端自动转到快照 |
| 页面磁盘缓存 | 6 小时 | 重复访问不产生请求，缓存在 `.cache/` |
| 逐场数据范围上限 | 21 天 | 且每次最多解析 2 个赛事，用批量接口一次取多个页面 |

**请保持默认值。** 若你需要高频或大范围的数据，请改用商业数据源（如 PandaScore），不要调小 `MIN_GAP_MS`。

被限流时网站不会坏：状态条会显示「内置快照」，赛历照常可用，比赛面板会说明原因。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `5173` | 监听端口 |
| `LIQUIPEDIA_UA` | 内置默认值 | 请求 Liquipedia 的 User-Agent。**建议换成你自己的联系方式**，这是对方接口条款的要求。 |
| `CACHE_TTL_MS` | `1800000` | 赛事时间轴缓存（30 分钟） |
| `PAGE_TTL_MS` | `21600000` | 页面内容缓存（6 小时） |
| `MIN_GAP_MS` | `3000` | 两次请求的最小间隔，**不建议调小** |
| `COOLDOWN_MS` | `1800000` | 被限流后的冷却时长 |

```bash
PORT=8080 LIQUIPEDIA_UA="MyBoard/1.0 (me@example.com)" node server.js
```

## 接口

| 路径 | 说明 |
|---|---|
| `GET /api/live` | 赛事时间轴（归一化 JSON），带缓存 |
| `GET /api/matches?from=YYYY-MM-DD&to=YYYY-MM-DD` | 指定范围内的逐场比赛 |
| `GET /api/health` | 服务状态、缓存年龄、冷却剩余、页面映射条数 |
| 两者都支持 `?force=1` | 忽略缓存强制刷新（请勿频繁使用） |

## 自检

两个测试都完全离线运行，不产生任何外部请求：

```bash
node tools/parser-test.js     # 48 项：Liquipedia wikitext 解析
node tools/smoke-test.js      # 42 项：前端渲染与交互（三套场景）
```

- `parser-test.js` —— 用真实抓取到的结构做 fixture，覆盖嵌套模板的平衡括号提取、`t1t`/`t1ct` 分侧回合求和、加时局字段、日期与时区（含 `CST` 在亚/美赛区的消歧）、空对阵过滤、时间轴合并。
- `smoke-test.js` —— 在最小 DOM 桩里**真实执行** `app.js`，覆盖实时可用 / 逐场失败 / 纯离线三套场景，并模拟点击时间与主办方筛选。

## 目录结构

```
CS2-events/                        ← 仓库根目录就是站点根目录
├── index.html                     页面骨架
├── calendar.html                  附加页：全年赛历表格版（可打印）
├── assets/
│   ├── style.css                  样式（自动适配深色模式）
│   └── app.js                     状态计算、渲染、筛选、年度导航、.ics 导出
├── data/
│   ├── tournaments.json           赛程快照（36 场）
│   └── page-map.json              赛事 id → Liquipedia 页面名（23 条）
├── tools/
│   ├── parser-test.js             解析器测试（48 项）
│   ├── smoke-test.js              前端冒烟测试（42 项）
│   ├── build-snapshot.js          构建期刷新快照（CI 用，best-effort）
│   └── resolve-pages.js           页面映射生成/校验工具
├── .github/workflows/
│   └── deploy-pages.yml           GitHub Pages 部署流水线
├── server.js                      静态托管 + 两个数据接口
├── package.json
└── .cache/                        运行后自动生成，已 gitignore
```

### 维护页面映射

`data/page-map.json` 记录赛事 id 与 Liquipedia 页面名的对应关系，逐场数据依赖它。赛事更替后可用工具重新生成：

```bash
node tools/resolve-pages.js
```

该工具会取赛事索引页的渲染 HTML 提取全部页面链接，再用 Infobox 的 `sdate`/`edate` 逐条校验（±4 天容差），只有通过的才写入。**注意：它会发出多次请求，请勿频繁运行**——参与 Liquipedia 的请求礼仪。

## 已知限制

- **队伍名映射不完整。** Liquipedia 的 `{{TeamOpponent|spirit}}` 只提供 slug，服务端内置了一份常见队伍对照表（约 70 条），未收录的会按 slug 推测显示（如 `some-team` → `Some Team`）。看到一个陌生的名字属正常现象。
- **部分赛事没有逐场数据。** Stake Ranked 系列赛、XSE 职业联赛、亚洲冠军联赛、电竞国家杯、极限之地等在 Liquipedia 上没有独立的比赛页，这些赛事会显示为空并说明原因。
- **Bo 制为反推值。** 比赛模板里不直接记录 Bo 制，服务端按胜局数推断（2 胜 → Bo3，3 胜 → Bo5），首局未打完时为空。

## 日期口径

同一场赛事常能看到两个起始日，原因不是谁抄错了，而是统计口径不同：主办方官网一般给出「含线上阶段 + 场馆阶段」的完整赛期，赛事日历通常只记正赛/场馆阶段。本看板主日期用后者，主办方口径作为附加标签显示在卡片内。

**仍在存疑的项：**

- 电竞世界杯 2026 举办地：BLAST 官方页与赛事结果站记为巴黎，另有多个信源记为沙特利雅得。
- BLAST Rivals 第二季：BLAST 官方公告为 11 月 8–15 日，Liquipedia 记为 11 月 11–15 日。
- PGL 新加坡 Major：PGL 官网记为 11 月 22 日起，场馆方记为 11 月 25 日–12 月 13 日。

## 许可

赛程与比赛数据来自 [Liquipedia](https://liquipedia.net/counterstrike/S-Tier_Tournaments/Post_2023)（CC-BY-SA 3.0），并交叉核对 BLAST.tv、ESL Pro Tour、PGL Esports、新加坡体育城等官方页面。

本项目仅供个人使用，与 Valve、ESL、BLAST、PGL 及 Liquipedia 均无关联。
