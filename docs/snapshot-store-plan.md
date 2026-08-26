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

- [ ] `node --check subscription-worker.js && node --check snapshot-store.js && node --check deploy-subscription-worker.js` 全部通过。
- [ ] **回归**：无 `DB` binding 时，所有现有路由、cron 邮件行为与改动前完全一致；`/api/snapshot-history` 返回 503。
- [ ] **首跑回填**：`POST /api/snapshot-run` 后，抽查某股票 `daily_bars` 行数≈2020 年以来交易日数，最新收盘与数据源一致；`daily_indicators` 各 period 均有序列。
- [ ] **幂等**：紧接着再跑一次，`rows_written` 只有增量（≤ 股票数 × 5 × 周期数），总行数不膨胀。
- [ ] **容错**：mock 单只股票拉取失败 → 其余正常入库，`snapshot_runs.stocks_failed` 计数正确。
- [ ] **板块**：`sector_daily` 有被追踪板块的合成指数序列，与 sectors.html 页面展示的口径一致。
- [ ] **预算**：把写入上限临时调小（如 1000）验证截停 + 下次续跑逻辑。
- [ ] 部署脚本 dry-run：formData 含 3 个模块文件，bindings 含 `{type:"d1", name:"DB"}`。

## 9. 上线步骤与回滚

1. 合并后运行 `node deploy-subscription-worker.js`（自动创建 D1 + binding）。
2. `POST /api/snapshot-run`（Bearer ALERT_SECRET）手动首跑，按 §8 抽查数据。
3. 次日 16:00 后确认 cron 自动写入了增量行。
4. 回滚：`DISABLE_D1=1` 重新部署 → Worker 全 no-op；D1 数据保留，随时可重新启用。
