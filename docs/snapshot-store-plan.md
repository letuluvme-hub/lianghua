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

# 验收记录一：初版实现（#4 / #5 / #6）

## 实现落点

| 文件 | 改动 |
|------|------|
| `snapshot-store.js` | 新建，672 行，零依赖、无 import 主 Worker |
| `subscription-worker.js` | +17 −3 行，严格限于 §5 的 5 个挂钩点 |
| `deploy-subscription-worker.js` | +24 −3 行，`ensureD1Database()` + d1 binding + 模块注册 + 输出字段 + `DISABLE_D1` |

`subscription-worker.js` 的 3 行删除全部来自挂钩点 3——把 `refreshSectorBollinger(env, bk).catch(...)` 改写成
`.then(persistSectorSnapshot).catch(...)` 的链式换行，没有任何现有函数体被改动。

## 实现中的判断与偏离说明

### 1. 板块合成口径：等权算术平均收盘价（计划要求"与前端一致"，但前端并不存在该口径）

按 §4 的要求先读了 `sectors.html`：该页面**只逐只展示成分股各自的布林带**（`stats(s.closes)` 对每只股票独立计算
中线/标准差/K1–K3），**没有任何"板块合成指数"**，`mcap` 只用于 TopN 选股和表格展示。因此不存在可对齐的既有口径，
需要在本模块里定下一个。选择**等权算术平均收盘价**（当日全部有收盘价的成分股收盘价的简单平均），理由：

- **时序可比性**：payload 里的 `mcap` 只有"当日快照"一个值。若用它做权重，同一个 `trade_date` 的指数值会随
  运行日漂移（每天重写最近 5 日时权重都不同），落库后的序列不可比。等权平均对给定
  `(bk, trade_date, 成分集合)` 完全确定，重复运行结果逐位一致。
- **与前端精神一致**：前端把 20 只成分股平等对待，等权是它最自然的聚合。
- **成分变动可识别**：TopN 名单换血会让指数跳变，`member_count` 列把这一点显式记录下来，
  后续做板块轮动强度时可以据此剔除跳变点。

若将来需要市值加权，正确做法是先落一张按日的 `sector_members(bk, trade_date, code, mcap)`，而不是拿当日快照
去回溯加权——那属于后续步骤，本次不做。

**右对齐**：`payload.stocks[].closes` 只给数组不给逐只日期，长度可能短于公共横轴 `dates`（停牌/次新）。
本模块按"最后一根 K 线对齐最新交易日"右对齐（`offset = dates.length - closes.length`），比前端图表隐含的
左对齐更准确；两者在长度一致的常规情况下完全等价。

### 2. `bandwidth_pct` 存的是比值不是百分数

按 §2 给出的公式 `4*stddev/middle` 实现（K=2 上下轨全宽 ÷ 中线）。列名沿用计划中的 `bandwidth_pct`，
但存的是**比值**，×100 才是百分数。代码与本文档均注明，避免后续查询误读。

### 3. 回填完成判据改用 KV memo，比"`daily_bars` 无记录"更稳

§3 建议用"`daily_bars` 中该 code 无记录"判断是否已回填。实测这一判据在**回填中途失败**时会误判：
部分批次已写入 → 下次运行看到有记录 → 转为增量，历史永远补不齐。改为在**全部批次成功后**才写
KV memo `snap:bf:{code}`，中途失败下次仍会重新完整回填（upsert 幂等，重跑无副作用）。
KV 不可用时退回 §3 的 D1 计数判据。这仍然满足"不新增进度表"的约束（只多一个 `snap:` 前缀 key）。

### 4. 预算截停：保底推进一只，避免死循环

§3 的"按股票为单位截停"在写入上限被调得很小时会死锁——单只股票的行数就大于总预算，于是每轮都跳过、
永远不推进。实现里加了一条：**本次运行还一行都没写时无条件写入当前这只**，保证任何预算下都单调推进。
> ⚠️ 这条"本次运行还一行都没写时无条件写入"的放行条件后来被证明不成立（已回填股票的增量写入每轮
> 都先执行，条件再也无法满足），见下一章《复审版计划的二次验收》缺陷 2。
另外，还有股票因预算被跳过时**不写** `snap:done` memo，让同窗口（16:00–16:02）的后续 cron 继续跑完。

上限默认 `MAX_ROWS_PER_RUN = 80_000`，可用环境变量 `SNAPSHOT_MAX_ROWS` 覆盖（§8 的截停验证用，无需改代码）。

**关于"个人规模首日即可完成全部回填"**：实测 19 只股票 × 3 个周期，2020 年以来 1736 个交易日
≈ 13 万行 > 8 万行预算，首日需要 **2 轮**。因 16:00–16:02 窗口内 cron 会触发 3 次且未跑完不写 memo，
首日仍在同一分钟窗口内自动跑完；手动 `POST /api/snapshot-run` 也可以连点几次直到 `note` 里不再出现
`budgetSkipped=`。周期集合越大、股票越多，轮数越多。

### 5. 模块内重复实现了若干小工具（有意为之）

`normalizeSecurityCode` / `inferMarket` / `mapWithConcurrency` / `fetchJsonWithRetry` / 新浪·雅虎日线拉取
等在 `snapshot-store.js` 里重新实现了一份。原因：§5 规定主 Worker 只能有 5 个挂钩点（不含新增 export），
且新模块 import 主 Worker 会形成循环依赖。重复换来的是"新模块 100% 不可能影响现有功能"——这是本次的最高原则。
数据源选择、复权口径、布林带口径（**总体标准差，除以 N**，与 `computeLatestBands` 一致）均照抄主 Worker。

新浪接口的 `datalen` 回填时取 1800（约 7 年，覆盖 2020 年以来）；增量时只取
`最长周期 + 5 + 60` 根，省带宽。雅虎按自然日区间取，增量时按交易日数 ×1.6 折算。

## 测试与验证

无法在本地跑真实 Cloudflare，因此搭了三套替身做端到端验证：**D1 用 `node:sqlite` 真实执行 SQL**
（真建表、真 upsert、真查询，不是 mock），KV 用 Map，行情源用确定性随机游走的合成日线
（新浪 / 雅虎 / 腾讯 / 东财四种响应格式都按真实结构伪造）。

### A. 模块层 `snapshot-store.js`（18 项，全部通过）

| 用例 | 结果 |
|------|------|
| 无 `env.DB` 时三个导出全 no-op | 零 fetch、零 KV 写入，`/api/snapshot-history` → 503 |
| 首跑回填 | `daily_bars` 覆盖 2020-01-01 以来全部 **1736** 个交易日；OHLCV 与数据源逐字段一致 |
| 指标序列 | period 20/30/60 各自长度 = 交易日数 − N + 1，滚动窗口无缺口 |
| 指标口径 | 中线/标准差/`sigma_offset`/`bandwidth_pct` 与 `computeLatestBands` 差 < 1e-9（总体标准差 ÷N） |
| 多市场 | A股走新浪、港股(00700)/美股(AAPL) 走雅虎，三类均入库 |
| 批大小 | 实测最大 50，未超 §2 上限 |
| universe | 订阅 stocks ∪ watchlist codes ∪ 默认自选 → 19 只，归一化去重正确 |
| 周期集合 | `note` 记录 `periods=20/30/60`（= {20} ∪ 订阅 period） |
| **幂等** | 重跑写入 **380 行** = 19 只 × 5 日 × (1 根日线 + 3 个周期)，为理论上限；`daily_bars`/`daily_indicators` 总行数**完全不变** |
| KV 防重 | 同日再次 cron → 命中 `snap:done:{日期}`，直接返回 `{skipped:"already done"}` |
| KV 侵入面 | 只新增 `snap:` 前缀 key，`sub:`/`alert:`/`watchlist:` 结构未动 |
| **容错** | mock `600183` 拉取 500 → `stocks_failed=1`、`stocks_ok=18`，其余照常入库，仅 warn |
| 板块合成 | 等权平均值逐点核对；成分股 closes 短于横轴时右对齐正确；`member_count` 逐日统计 `[2,2,3,3]` |
| 板块幂等 | 二次落库行数不膨胀 |
| 查询 API | 升序返回、`Cache-Control: public, max-age=600`、字段集合正确 |
| 参数校验 | `days` 默认 120 / 上限 500（999 → 400）、`period` 默认 20（1 → 400）、`code` 空 → 400 |
| **预算截停** | `SNAPSHOT_MAX_ROWS=1000` 时按股票截停，三轮累计推进 4 只，未提前写 done memo；单只超总预算也不死锁 |
| `snapshot_runs` | 按北京日期一行，起止时间/成功失败数/写入行数/note 齐备 |

### B. 主 Worker 层（8 项，全部通过）

| 用例 | 结果 |
|------|------|
| 无 D1：`/api/health`、404 兜底 | 与改动前一致 |
| 无 D1：`/api/snapshot-history` | 503，其余路由不受影响 |
| `/api/snapshot-run` 鉴权 | 无 Authorization → 401；错 token → 401；对 token → 200 `{run:null}`（无 D1） |
| 无 `ALERT_SECRET` 的 env | 不 500 |
| **无 D1 的完整 cron**（钉在周三北京时间 16:00） | 板块 KV 缓存、`sector:list:v1` 照常写入，行为与改动前一致 |
| 有 D1 的 cron（挂钩点 2/3） | 17 只默认自选个股快照 + `sector_daily` 板块序列同时落库；末日指数 = 两只成分股收盘等权平均（差 < 1e-9），`member_count=2`，`name="PCB"` |
| 挂钩点 4 | `/api/snapshot-history?code=600036&period=20&days=30` 返回 30 行 |
| 挂钩点 5 | `POST /api/snapshot-run` 跳过 memo 强制重跑，返回 `snapshot_runs` 行（增量 170 行 = 17×5×2） |
| **门控** | 钉在北京时间 10:00 跑 cron → D1 语句数 **0**，与板块刷新同门，窗口外不写任何东西 |

### C. 部署脚本干跑（6 项，全部通过）

| 场景 | 结果 |
|------|------|
| multipart 分片 | `["metadata", "subscription-worker.js", "ai-interpreter.js", "snapshot-store.js"]`，`main_module` 仍是 `subscription-worker.js` |
| D1 不存在 | `GET /d1/database` → 空 → `POST /d1/database` 创建，binding = `{type:"d1", name:"DB", id:"<uuid>"}` |
| D1 已存在 | 复用 uuid，**不再** POST 创建（幂等） |
| bindings 全集 | `kv_namespace:SUBSCRIPTIONS`、`d1:DB`、`inherit:RESEND_API_KEY`、`inherit:ALERT_SECRET` —— 既有 secret inherit 逻辑未受影响 |
| 输出 JSON | 含 `d1Database: "boll_snapshots"` |
| `DISABLE_D1=1` | 不请求 `/d1/database`、bindings 无 d1 项、模块仍上传（Worker 侧全 no-op），输出 `d1Database: "disabled (DISABLE_D1=1)"` |

### D. 语法检查

`node --check` 对 `subscription-worker.js` / `snapshot-store.js` / `deploy-subscription-worker.js` 均通过。

## 已知取舍 / 待观察

- **回填历史深度受数据源限制**。新浪 `getKLineData` 单次最多返回约 1800 根日线（约 7 年），
  对 2020-01-01 起点当前刚好够；若干年后需要改用支持分页的数据源，否则最早的历史会滚出窗口
  （已入库的行不会丢，只是不再被 upsert 覆盖）。雅虎按区间取，无此问题。
- **D1 subrequest 预算**。回填一只股票会产生上百个 `batch()` 调用，Workers 的单次请求 subrequest 上限
  （免费档 50 / 付费档 1000）可能在大规模回填时触顶。触顶表现为该股票抛错 → 计入 `stocks_failed` →
  因未写 `snap:bf:` memo，下次运行重新完整回填。不会产生半截数据，但可能需要多跑几轮。
  个人规模（≤ 40 只、周期集合 ≤ 3）实测无碍。
- **`amount`（成交额）恒为 NULL**。新浪 / 雅虎两个接口都不返回成交额，列先留着，
  将来换数据源或补腾讯接口时可以直接回填。
- **`snapshot_runs` 一天只留最后一次运行**。`run_date` 是主键、冲突时整行覆盖（不累加），
  这样"紧接着重跑一次看 `rows_written` 是不是只有增量"的排查方式最直观；代价是同日多轮续跑时
  只能看到最后一轮的数字，跨轮总量需要自己数 `daily_bars`。
- **未做前端**。历史曲线展示、带宽收窄筛选等留给后续步骤；`/api/snapshot-history` 已经就绪可直接消费。

## 上线后修补

**全新 D1 首跑前查询返回 500**（上线当天发现并修复）。建表只发生在 `runDailySnapshot` /
`persistSectorSnapshot` 里，而 `handleSnapshotHistory` 直接查 `daily_indicators`：新库在第一次
快照跑完之前没有这张表，SQLite 的 `no such table` 被兜底成 500「查询失败」。语义上，查一个还没
入库的代码就是「没有数据」，应当返回 200 + 空数组。已在查询处单独捕获该错误并返回空结果；
其他故障（网络、D1 不可用等）仍照旧冒泡成 500，不被误吞。

回归用例 6 项：表不存在 → 200 空数组且保留缓存头；400/503 分支不变；建表入库后照常返回真实序列；
有表但该代码无数据 → 同样 200 空数组（两种「没数据」语义一致）；非表缺失的故障仍为 500。

**雅虎当日 bar 返回 `close=0`**（首次回填后对账发现）。首跑落库 24,922 根日线后逐只核对，发现 5 条
`close=0` 而 O/H/L/成交量正常的记录，全是港股（00700/00941/01810/03690/09988）、全在同一天 ——
雅虎对尚未定盘的当日 bar 会给出 0 收盘价。原过滤只挡 `null`（`numberOrNull(0)` 是有限数，直接放行），
于是 0 被写进 `daily_bars`，并毁掉包含它的整个指标窗口：那 5 行指标带宽 91.9%~94.0%、σ 偏离 −4.3。

修复：新增 `positivePriceOrNull()`，收盘价必须是**有限正数**，0 / 负数 / NaN 一律视为「这根 bar 没有
收盘价」而整根丢弃；新浪路径同样加固。

**同一个洞也存在于 `subscription-worker.js` 的 `fetchYahooKlines`**（`Number.isFinite(rawClose)` 同样
放行 0），属于本模块之前就有的既有缺陷，但影响更大：0 收盘价会让 `computeLatestBands` 算出假的
「跌破下轨」触发**误报预警邮件**，前端 K 线也会掉到 0，且等比前复权时 `adj / rawClose` 会得到 Infinity。
一并按同样口径加固。

线上已清理：5 条脏 bar + 5 行被污染的指标（`DELETE ... WHERE close<=0` 及其对应指标行），
港股序列回到最后一个有效交易日。回归用例 7 项：脏 bar 被丢弃且不误杀正常数据；指标带宽/σ 偏离
回到正常量级；`/api/klines` 不再返回 0 收盘价；σ 偏离由 −4.29 回到 1.648（不再误报）。

---

# 验收记录二：复审版计划的二次验收（#7）

> 计划正文在 #4 合入之后又被复审修正过（PR #1 的 commit `8fd64fa`：预算截停与防重 memo 的
> 一致性、`force` 签名、KV `list()` 分页）。本章按**修正后**的计划重跑 §8，上面那一章记录的是
> 初版实现按修正前计划的验收结果，两处结论冲突时以本章为准。
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

额外补跑的两项（不在 §8，但属于失败安全约束）：

- **D1 被重建后仍能补回历史**——换一个空库、沿用原 KV（回填 memo 还在），下一跑重新走全量回填
  而不是退化成每天 5 行。
- **#6 的 `close=0` 修复在本分支上仍然成立**（合入基线分支后补跑，9/9 通过）——给港股与 A 股
  两条数据源路径各注入一根 `close=0` 的当日 bar：整根被丢弃、`daily_bars` 无非正收盘价、序列停在
  最后一个有效交易日、其余 1736 根照常入库、未受影响的代码不被误杀、指标窗口未被污染。

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

> 本章全部数字都是在合入基线分支 #6（雅虎 `close=0` 修复）之后重跑的：`node --check` × 3、
> 模块级 57/57、Worker 挂钩点级 15/15、`close=0` 回归 9/9、部署 dry-run 3 个场景，全部通过。


---

# 上线后事故复盘：cron 连续 24 分钟全线失败

## 现象

首次接入 D1 后的第一个 cron 快照窗口（北京 2026-08-27 16:00），Workers 调用分析显示：

```
07:59:17Z  success             cpu=17ms
08:00:21Z  exceededResources   cpu=627ms   ← 快照回填被运行时掐断
08:01:17Z  exceededResources   cpu=10ms
…每分钟一次，直到 08:24 重新部署为止，连续 22+ 次
```

`shouldRefreshPcbNow()` 在 08:03 之后就关闭了，快照/板块任务根本没被创建，失败的是
`sendDueSubscriptions` / `sendDueAlerts` 这条基础路径 —— 也就是说**日报与预警邮件停发了 24 分钟**。
同期 fetch 入口（`/api/health` 等）一直正常，故障只在 cron。

## 根因链

1. 16:00 那次 cron 要为 7 只新增订阅股票做首次回填，约 2.3 万行、约 450 个 batch。
2. 单轮写入上限当时是 **80,000 行**，对「D1 每日额度」是合理的，但对「一次 Workers 调用
   能提交多少」远远过宽，`reserve()` 一路放行，调用在写到约 1.87 万行、约 375 个 batch 时
   被以 `exceededResources` 掐断（指标写到一半、`snapshot_runs` 没落盘）。
3. 被掐断的调用留下了**没有超时的出站请求**：两处 `fetchJsonWithRetry`（本模块与主 Worker）
   都是裸 `fetch(url, options)`，没有 `AbortSignal`。悬挂的 promise 把 isolate 钉死。
4. 之后每一分钟的 cron 触发进到同一个被钉死的 isolate，10ms 就 `exceededResources`，
   自身完全无辜。重新部署强制生成新 isolate 后立刻恢复（08:24:17 起全部 success）。

## 修复

| 改动 | 位置 | 作用 |
|------|------|------|
| 每次出站请求加 `AbortSignal.timeout(15s)` | `snapshot-store.js` + `subscription-worker.js` 的 `fetchJsonWithRetry` | 断掉第 3 步，挂死的数据源不再能钉死 isolate |
| `MAX_ROWS_PER_RUN` 80,000 → **12,000** | `snapshot-store.js` | 断掉第 2 步。约 240 个 batch，只有致死量级的六成多 |

上限取值的权衡：单只股票回填约 3.4k 行，1.2 万约放行 3 只/轮。再低会拖慢新增股票的首次回填
（6,000 时只放行 1 只/轮，17 只要 17 轮、按每天 3 次 cron 要 6 天）；再高就逼近实测被掐断的位置。
首次上线要一次灌满时用 `POST /api/snapshot-run`（force）连点几次，比等 cron 快得多。

## 同期修复的数据损伤

被掐断的那次留下 3 只股票「bars 完整、指标半截」（603986 断在 2022-09-14、688008 断在
2021-09-01、688012 无 memo）。PR #7 已把 `isBackfilled` 改成「D1 有行 **且** memo 存在」，
这类半截状态下次运行会自动重新完整回填 —— 已借 D1 REST 通道跑模块自身的 `runDailySnapshot`
当场补齐，24 只全部 `bars − indicators = 19`（period=20 的正常滚动窗口）。

## 仍未解决（既有问题，不在本模块范围）

`sector_daily` 至今为 0 行。原因是**板块刷新本身早就不工作了**，与本模块无关：`sector:tracked`
里 13 个板块的 `sector:bollinger:*` 缓存最新的是 2026-08-26（1 个），其余停在 7 月；而
`sector:list:v1` 每天都能刷新成功。即在 `refreshSectorList()` 之后、逐板块
`refreshSectorBollinger()` 阶段失败 —— 13 个板块 × (1 次成分 + 20 次 K 线) ≈ 273 次出站请求
挤在同一次调用里。本次给主 Worker 的 `fetchJsonWithRetry` 加超时会改善「挂死」这一类，但
「一次调用塞不下 273 次请求」需要把板块刷新拆散到多个 cron 分片，属于板块模块自身的改造。
