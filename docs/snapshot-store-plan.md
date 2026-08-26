# 实施计划：每日指标快照落库模块（snapshot-store，第二步）

> 本文档是给实现者（人或 agent）的完整施工图。目标：把每日的个股/板块指标快照持久化到 Cloudflare D1，为系统积累历史时序数据资产。
> **最高原则：独立新模块，任何情况下不得影响现有功能** —— 未配置 D1 binding 时，系统行为与今天完全一致。

## 0. 背景与依赖（实现前必读）

- **为什么做**：当前 K 线即抓即用，KV 只存订阅/自选/当日缓存，系统没有"昨天 vs 今天"的记忆。落库后才能支撑：带宽收窄/放大趋势、连续 N 日触轨、板块轮动强度、以及后续给 AI 解读模块（第一步）提供历史上下文。
- **依赖第一步**：`claude/ai-interpreter-module-6luhoh` 分支已实现部署脚本的**多模块上传**（`uploadWorker` 中的 `extraModules` 数组循环 `formData.append`）。**本模块必须基于该分支（或其合并后的默认分支）开发**，直接向 `extraModules` 注册新文件；若从旧默认分支开发会缺少该机制。
- 项目约束不变：零依赖、无构建步骤、Worker 原生 API；不能引入 npm 包。
- 相关现状（挂钩点所在）：
  - `scheduled()`（subscription-worker.js 底部 export default 内）：cron 每分钟触发；`shouldRefreshPcbNow()` 门控出"北京时间工作日 16:00–16:02"窗口，窗口内已有板块刷新任务。
  - `fetchStockSnapshot(code, period)`：A股走 `fetchSinaKlines`、美股走 `fetchYahooKlines`，`beg: "20200101"` 起拉全量日线 —— 回填历史的原料现成。
  - 订阅存 KV：`sub:` / `alert:` 前缀，含 `stocks`（代码数组）与 `period`；自选存 `watchlist:${email}`，`{codes: [...]}`。
  - 板块：`refreshSectorBollinger(env, bk)` 每日 16:00 刷新，payload 含 `bk/name/dates/stocks[{code,name,mcap,closes}]/latestTradeDate`；被追踪板块集合来自 `getTrackedSectors(env)`。
  - 部署脚本 binding 用 secret_text/inherit 模式；D1 是新的 binding 类型（见 §6）。

## 1. 交付物清单

| # | 文件 | 动作 |
|---|------|------|
| 1 | `snapshot-store.js` | **新建**。独立 ES module，含建表、采集、回填、查询全部逻辑 |
| 2 | `subscription-worker.js` | 微改。仅 5 个挂钩点（见 §5），不动任何现有函数体逻辑 |
| 3 | `deploy-subscription-worker.js` | 微改。D1 数据库幂等创建 + binding + extraModules 注册（见 §6） |
| 4 | `docs/snapshot-store-plan.md` | 本文档，实现后在末尾附验收记录 |

## 2. D1 数据库设计

数据库名 `boll_snapshots`，Worker binding 名 **`DB`**。建表语句由 Worker 自己执行（`CREATE TABLE IF NOT EXISTS`，每次快照运行开头跑一遍，幂等，不引入迁移工具）。

```sql
-- 原始日线（数据源无关的原料层，指标可随时重算）
CREATE TABLE IF NOT EXISTS daily_bars (
  code TEXT NOT NULL,            -- normalizeSecurityCode 后的代码
  trade_date TEXT NOT NULL,      -- YYYY-MM-DD，取自 K 线自身日期（天然规避节假日问题）
  close REAL NOT NULL,
  open REAL, high REAL, low REAL, volume REAL, amount REAL,
  PRIMARY KEY (code, trade_date)
);

-- 指标层（按使用中的周期集合预计算，便于直接 SQL 查询）
CREATE TABLE IF NOT EXISTS daily_indicators (
  code TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  period INTEGER NOT NULL,       -- 布林带周期 N
  close REAL NOT NULL,
  middle REAL NOT NULL,
  stddev REAL NOT NULL,
  sigma_offset REAL,             -- (close-middle)/stddev
  bandwidth_pct REAL,            -- 4*stddev/middle（K=2 上下轨全宽/中线），带宽收窄查询直接用
  PRIMARY KEY (code, trade_date, period)
);

-- 板块合成指数层
CREATE TABLE IF NOT EXISTS sector_daily (
  bk TEXT NOT NULL,              -- BKxxxx
  trade_date TEXT NOT NULL,
  name TEXT,
  index_value REAL NOT NULL,     -- 合成方法必须与 sectors.html 前端一致（实现前先读前端代码确认等权/加权）
  member_count INTEGER,
  PRIMARY KEY (bk, trade_date)
);

-- 运行日志（排查用）
CREATE TABLE IF NOT EXISTS snapshot_runs (
  run_date TEXT PRIMARY KEY,     -- 北京时间日期
  started_at TEXT, finished_at TEXT,
  stocks_ok INTEGER, stocks_failed INTEGER,
  rows_written INTEGER, note TEXT
);
```

写入一律 `INSERT ... ON CONFLICT(...) DO UPDATE`（幂等 upsert），用 `env.DB.batch([...])` 批量提交，**每批 ≤ 50 条语句**。

## 3. 快照范围（universe）与回填策略

- **股票集合** = 所有 `sub:`/`alert:` 订阅的 `stocks` ∪ 所有 `watchlist:` 键的 `codes` ∪ `DEFAULT_WATCHLIST_CODES`，`normalizeSecurityCode` 后去重；上限 200 只（超出截断并 `console.warn` 被丢弃的部分）。注意 KV `list()` 是分页的（单次最多 1000 keys）：要循环携带 `cursor` 直到 `list_complete` 为 true，不能只取第一页。
- **周期集合** = `{20}` ∪ 各订阅的 `period` 去重。
- **板块集合** = `getTrackedSectors(env)`。
- **增量 vs 回填**：
  - 某股票在 `daily_bars` 已有记录 → 只 upsert **最近 5 个交易日**（容忍数据源事后修正）。
  - 首次入库 → **回填**：利用本来就拉到的 2020 年以来全量序列，滚动计算各 period 的指标序列一并入库。
- **写入预算（D1 免费档每日写入行数有限）**：模块内置单次运行写入上限（默认 80,000 行，常量可调）。超预算时**在股票边界截停**：开写某只股票的回填前先估算其行数（序列长度 × 周期数），剩余预算不够就整只跳过留给下次——绝不写入半只股票的历史，这样"`daily_bars` 中该 code 无记录即未回填完成"这一续跑判据才成立，无需额外进度表。个人规模（几十只股票）首日即可完成全部回填。

## 4. 新模块 `snapshot-store.js` 接口

```js
// 三个导出全部遵守：【永不 throw】；env.DB 未绑定 → 立即 return（功能整体关闭）。
export async function runDailySnapshot(env, opts = {})      // opts.force = true 跳过 KV memo 防重（手动触发用）
export async function persistSectorSnapshot(env, payload)   // payload = refreshSectorBollinger 的返回值
export async function handleSnapshotHistory(request, env)   // GET /api/snapshot-history 的处理器
```

`runDailySnapshot` 流程：建表 → 防重检查（KV memo `snap:done:{北京日期}`，命中且非 `opts.force` 即返回）→ 汇总 universe → `mapWithConcurrency(4)` 拉 K 线（数据源选择照抄 `fetchStockSnapshot`：A股 Sina / 美股 Yahoo）→ 按 §3 增量或回填 → 写 `snapshot_runs`。**done memo 只在完整完成（本次未因预算截停任何股票）时写入**：截停时不写，16:00–16:02 容错窗内 cron 还会进来 1–2 次，可继续回填下一批；仍未完成的留到次日 16:00 续跑（upsert 幂等，重复进入无害）。单只股票失败 warn 后继续（照抄 `sendDueAlerts` 的逐项兜底风格），不拖垮批次。

`persistSectorSnapshot`：从 payload 的 `dates` × `stocks[].closes` 计算每日合成指数（**方法与 sectors.html 前端一致，实现前必须先读前端确认**），首次全量、之后只 upsert 最近 5 日。

`handleSnapshotHistory`：`GET /api/snapshot-history?code=600183&period=20&days=120`（period 默认 20，days 默认 120、上限 500），从 `daily_indicators` 查询按日期升序返回 `{ code, period, rows: [...] }`；响应加 `Cache-Control: public, max-age=600`。参数非法返回 400；`env.DB` 缺失返回 503 `{ error: "snapshot 功能未启用" }`。

## 5. `subscription-worker.js` 的 5 个挂钩点（改动全集，不得超出）

1. 文件头部：`import { runDailySnapshot, persistSectorSnapshot, handleSnapshotHistory } from "./snapshot-store.js";`
2. `scheduled()` 中 `shouldRefreshPcbNow()` 门内追加：`tasks.push(runDailySnapshot(env));`（与既有任务并列，各自 catch，互不影响）。
3. `scheduled()` 板块刷新回调里，`refreshSectorBollinger(env, bk)` 成功后追加 `.then((payload) => persistSectorSnapshot(env, payload))`（不改 `refreshSectorBollinger` 函数本身）。
4. `fetch` 路由表新增：`/api/snapshot-history`（GET，公开只读）→ `handleSnapshotHistory`。
5. `fetch` 路由表新增：`/api/snapshot-run`（POST，`Bearer ALERT_SECRET` 鉴权，照抄 `/api/send-alerts` 写法）→ 手动触发 `runDailySnapshot(env, { force: true })`，返回 `snapshot_runs` 最新一行。用于上线首跑与排查。

## 6. `deploy-subscription-worker.js` 改动

1. **幂等创建 D1**：新增 `ensureD1Database()` —— `GET /accounts/{accountId}/d1/database` 列表按 `name === "boll_snapshots"` 查找；无则 `POST /accounts/{accountId}/d1/database` body `{ name: "boll_snapshots" }`；返回 `uuid`。
2. **binding**：`bindings.push({ type: "d1", name: "DB", id: <uuid> })`。注意：D1 binding 不支持 inherit 语义问题——每次部署都显式带上即可（uuid 稳定）。
3. **模块注册**：`extraModules` 数组追加 `snapshot-store.js`（读文件方式照抄 ai-interpreter.js 的处理）。
4. 结尾输出 JSON 增加 `d1Database: "boll_snapshots"` 字段。
5. **可选关闭开关**：环境变量 `DISABLE_D1=1` 时跳过 1/2 两步（不建 D1、不加 binding），Worker 侧因 `env.DB` 缺失自动全 no-op —— 这是整体回滚路径。

## 7. 明确不做（Out of scope）

- 不做任何前端/UI（历史曲线展示留待后续）。
- 不改 `ai-interpreter.js`（让 AI 解读读取 D1 历史是第三步的事）。
- 不做宏观/情绪/资金等新指标源（后续步骤）。
- 不引入迁移框架、npm 依赖或构建步骤。
- 不动 KV 既有数据结构（只新增 `snap:` 前缀 memo key）。

## 8. 验收标准（实现者自测清单）

- [x] `node --check subscription-worker.js && node --check snapshot-store.js && node --check deploy-subscription-worker.js` 全部通过。
- [x] **回归**：无 `DB` binding 时，所有现有路由、cron 邮件行为与改动前完全一致；`/api/snapshot-history` 返回 503。
- [x] **首跑回填**：`POST /api/snapshot-run` 后，抽查某股票 `daily_bars` 行数≈2020 年以来交易日数，最新收盘与数据源一致；`daily_indicators` 各 period 均有序列。
- [x] **幂等**：紧接着再跑一次，`rows_written` 只有增量（≤ 股票数 × 5 × 周期数），总行数不膨胀。
- [x] **容错**：mock 单只股票拉取失败 → 其余正常入库，`snapshot_runs.stocks_failed` 计数正确。
- [x] **板块**：`sector_daily` 有被追踪板块的合成指数序列，与 sectors.html 页面展示的口径一致。
- [x] **预算**：把写入上限临时调小（如 1000）验证截停 + 下次续跑逻辑。
- [x] 部署脚本 dry-run：formData 含 3 个模块文件，bindings 含 `{type:"d1", name:"DB"}`。

## 9. 上线步骤与回滚

1. 合并后运行 `node deploy-subscription-worker.js`（自动创建 D1 + binding）。
2. `POST /api/snapshot-run`（Bearer ALERT_SECRET）手动首跑，按 §8 抽查数据。
3. 次日 16:00 后确认 cron 自动写入了增量行。
4. 回滚：`DISABLE_D1=1` 重新部署 → Worker 全 no-op；D1 数据保留，随时可重新启用。

---

# 验收记录（实现后补充）

## 实现落点

| 文件 | 状态 |
|------|------|
| `snapshot-store.js` | 新建，727 行，零依赖，不 import 主 Worker |
| `subscription-worker.js` | +17 −3 行，严格限于 §5 的 5 个挂钩点 |
| `deploy-subscription-worker.js` | +24 −3 行，`ensureD1Database()` + d1 binding + 模块注册 + 输出字段 + `DISABLE_D1` |
| `docs/snapshot-store-plan.md` | 本文档 + 本节验收记录 |

`subscription-worker.js` 的 3 行删除全部来自挂钩点 3——把 `refreshSectorBollinger(env, bk).catch(...)`
改写成 `.then(persistSectorSnapshot).catch(...)` 的链式换行，没有任何现有函数体被改动。

## 验收方法

§8 各项都是**真跑**出来的，不是代码走查。为此搭了一套仿真环境（放在会话临时目录，按 §1
交付物清单不入库）：

- **D1**：`node:sqlite` 内存库包一层 D1 接口（`prepare/bind/run/first/all/batch`），SQL 语义
  为真——`ON CONFLICT` 幂等、`batch()` 单事务、缺表时抛 `no such table` 都与线上一致。
- **KV**：`list()` 按 `pageSize` 分页并返回 `cursor`/`list_complete`；验收时故意设成
  `pageSize=2`，"只取第一页"的实现会当场漏掉订阅。
- **行情**：拦截 `globalThis.fetch`，按代码种子生成 2020-01-01 至今 1737 个交易日的确定性
  日线，分别按新浪 / 雅虎的报文格式返回；指定代码可注入 HTTP 500。
- **时钟**：`worker.scheduled()` 的测试把 `new Date()` 固定到北京时间周三 16:00:30，
  让 `shouldRefreshPcbNow()` 真放行，从而端到端验证挂钩点 2/3（而不是只看 diff）。

测试宇宙：17 个默认自选 ∪ 订阅/自选独有的 `600519`/`000001`/`09618` = 20 只；
周期集合 `{20}` ∪ 订阅的 `{30,60}`；单只回填 6841 行（1737 日线 + 1718/1708/1678 指标）。

结果：模块级 **57/57 通过**，Worker 挂钩点级 **15/15 通过**，部署脚本 dry-run 3 个场景全通过。

## §8 逐项结果

| # | 验收项 | 结果 |
|---|--------|------|
| 1 | `node --check` × 3 | 通过 |
| 2 | 回归：无 `DB` binding | `runDailySnapshot`/`persistSectorSnapshot` 返回 `null`，**零网络请求、零 KV 读写**；`/api/snapshot-history` 返回 503 `{error:"snapshot 功能未启用"}`；`worker.scheduled()` 不抛错、不写任何 `snap:` 键，板块 KV 缓存照常写入 |
| 3 | 首跑回填 | `POST /api/snapshot-run` 后 `daily_bars` 每只 1737 行 = 2020 年以来交易日数；最新 `trade_date`/`close` 与数据源逐位一致；period 20/30/60 各有 1718/1708/1678 行；`rows_written=136820` 与理论值相符；中线/标准差与 `computeLatestBands` 的 ÷N 总体标准差一致，`bandwidth_pct` = 4σ/中线；每批语句数 ≤ 50 |
| 4 | 幂等 | 紧接着 force 再跑：`daily_bars` 34740→34740、`daily_indicators` 102080→102080 不膨胀；`rows_written=400` = 20 只 × (5 日线 + 3 周期 × 5)；`snapshot_runs` 同 `run_date` 覆盖而非累加 |
| 5 | 容错 | 注入 `NVDA` 拉取 500：`stocks_ok=19`、`stocks_failed=1`，失败股票零残留行，其余 19 只完整入库，`snapshot_runs` 计数一致 |
| 6 | 板块 | `sector_daily` 落库等权算术平均收盘价，`member_count` 记录当日有效成分数；次新股短序列右对齐到最新日期；首次全量 40 行、再次运行只 upsert 最近 5 日且总行数不变；重复运行结果逐位一致。cron 端到端跑出的 `BK0877` 指数 = 两只成分股当日收盘的算术平均 |
| 7 | 预算 | 上限调到 1000（单只回填 6841 行 > 单轮预算）：全程**没有出现过半只股票的历史**（每个已入库代码的日线行数恒为 1737）；未跑完时不写 done memo，第 21 次跑完 20 只后才写；写完后再跑命中 memo 直接返回；`force:true` 跳过防重 |
| 8 | 部署 dry-run | formData 含 `subscription-worker.js`/`ai-interpreter.js`/`snapshot-store.js` 三个 `application/javascript+module`；bindings 含 `{type:"d1",name:"DB",id:...}`；D1 已存在时复用 uuid 不重复创建；`DISABLE_D1=1` 时完全不碰 `/d1/` 接口、不加 binding，三个模块照常上传 |

额外补跑的一项（不在 §8，但属于失败安全约束）：**D1 被重建后仍能补回历史**——换一个空库、沿用
原 KV（回填 memo 还在），下一跑重新走全量回填而不是退化成每天 5 行。

## 验收中发现并修掉的两个缺陷

两个都在写入预算这条线上，都是先被上面的仿真跑出来、再改的代码；改动只落在
`snapshot-store.js`，`subscription-worker.js` 与 `deploy-subscription-worker.js` 一行未动。

### 1. 并发下预算失守（实测超上限 27 倍）

原实现是"先查剩余预算 → 写 → 写完记账"。`mapWithConcurrency(4)` 的 4 个 worker 在第一轮
同时读到"已写 0 行"，于是 4 只股票全部走了"本次还没写过、无条件放行"的例外分支：
上限 1000 行的那一跑实际写了 **27364 行**。D1 免费档按日计写入行数，这是会真花钱的。

改法：把预算收成 `createWriteBudget()`，`reserve()` 全程同步（内部没有 `await`），
Workers 单线程下天然互斥，两只股票不可能同时越过上限。

### 2. 回填永久卡死（更严重）

原例外分支的条件是"本次运行还一行没写"。可一旦有股票回填完成，后续每一轮都会**先**写它们
的增量行（20 只 × 20 行 = 400 行），`spent()` 立刻大于 0，例外分支再也不会触发；而剩下那些
"单只体量就大于单轮预算"的股票每轮都因装不下被跳过——**永远回填不完**。实测：上限 1000 行
跑满 40 轮，只回填出 4 只，`budgetSkipped=16` 稳定复现，且 done memo 因此永不写入，
cron 每天空转。

改法：例外分支的条件从"本轮还没写过任何行"改成"**本轮还没有任何回填被放行**"，即每轮至少
保证一只待回填股票落地（超预算也放行，超出量上界是一只股票）。修复后同样的上限跑 21 轮
覆盖全部 20 只，逐轮都不出现半只股票，跑完即写 memo。

线上默认值（80000 行上限、单只 6841 行）本来就走不到例外分支，这两个缺陷只在预算被调小或
universe 涨到几十只以上时暴露——也正是 §8 第 7 项要求验证的场景。

## 实现中的判断与偏离说明

### 1. 板块合成口径：等权算术平均收盘价（计划要求"与前端一致"，但前端并不存在该口径）

按 §4 的要求先读了 `sectors.html`：该页面**只逐只展示成分股各自的布林带**（`stats(s.closes)`
对每只股票独立计算中线/标准差/K1–K3），**没有任何"板块合成指数"**，`mcap` 只用于 TopN 选股
和表格展示（`fmtNum(r.mcap, 2)` 那一处）。因此不存在可对齐的既有口径，需要在本模块里定下一个。
选择**等权算术平均收盘价**（当日全部有收盘价的成分股收盘价的简单平均），理由：

- **时序可比性**：payload 里的 `mcap` 只有"当日快照"一个值。若用它做权重，同一个 `trade_date`
  的指数值会随运行日漂移（每天重写最近 5 日时权重都不同），落库后的序列不可比。等权平均对给定
  `(bk, trade_date, 成分集合)` 完全确定，重复运行结果逐位一致（已验收）。
- **与前端精神一致**：前端把 TopN 成分股平等对待，等权是它最自然的聚合。
- **成分变动可识别**：TopN 名单换血会让指数跳变，`member_count` 列把这一点显式记录下来，
  后续做板块轮动强度时可以据此剔除跳变点。

### 2. 回填完成判据：D1 记录为准，KV memo 只作为附加收紧条件

§3 定的续跑判据是"`daily_bars` 中该 code 无记录即未回填完成"。这条在"整只股票要么全写要么
不写"的前提下成立，但回填要跨几十个 `batch()` 提交（每批 ≤ 50 条），中途失败会留下"有行但
不完整"的历史，光看"有没有行"识别不出来。所以额外写了个 `snap:bf:{code}` 的 KV memo，
**全部批次成功后才落**，两个条件同时成立才算回填完成。

反过来也必须成立：memo 不能单独说了算。D1 换库或 `DISABLE_D1` 往返之后 memo 还在，只信 memo
会让该股票退化成每天只写 5 行、历史再也补不回来——这一点已单独补了验收用例。

`snap:bf:` 属于 §7 允许的 `snap:` 前缀新增键，不动任何既有 KV 结构。

### 3. `SNAPSHOT_MAX_ROWS` 环境变量

§3 说写入上限是"常量可调"。为了让 §8 第 7 项能在不改代码、不重新部署的前提下验证截停与续跑，
上限做成"默认 `MAX_ROWS_PER_RUN = 80000`，可被 `env.SNAPSHOT_MAX_ROWS` 覆盖"。不设该变量时
行为与纯常量完全一致。

## 未覆盖的部分（如实说明）

- 仿真用的是 `node:sqlite` 与 mock 行情，**没有连真的 Cloudflare D1、新浪/雅虎/东财/腾讯接口**。
  SQL 语义、分页语义、报文形状都按线上对齐，但真实网络的限流、字段缺失、D1 的并发/大小限制
  仍需按 §9 上线步骤在真环境跑一次首跑来确认。
- 挂钩点 3 的板块链路验证中，东财成分股排名与腾讯日线是 mock 的（板块清单接口故意返回 500，
  用来确认它挂掉时不影响落库）。
- 验收脚本按 §1 交付物清单没有入库；如需复跑，本节"验收方法"已写清仿真环境的构成。
