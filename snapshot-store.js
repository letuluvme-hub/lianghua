// 每日指标快照落库模块（独立、可选、失败即降级）。
//
// 设计约束（与 ai-interpreter.js 同源）：
// 1. 零依赖，只用 Worker 原生 API；本文件不 import subscription-worker.js，
//    所需的通用小工具（代码归一化、并发 map、K线拉取…）在此重新实现，
//    以保证「新模块任何情况下不影响现有功能」——主 Worker 只多 5 个挂钩点。
// 2. 三个导出永不 throw：任何异常路径都吞掉并记 warn，调用方拿到 null/undefined。
// 3. 未绑定 D1（env.DB 缺失）时整体关闭：不建表、不拉数据、不写 KV，零成本，
//    行为与未接入本模块时逐字节一致。这也是整体回滚路径（部署时 DISABLE_D1=1）。

const MAX_UNIVERSE = 200; // 单次快照最多覆盖多少只股票（超出截断并 warn）
const MAX_ROWS_PER_RUN = 80_000; // 单次运行写入行数上限（D1 免费档每日写入有限额）
const BATCH_SIZE = 50; // 每个 env.DB.batch() 最多多少条语句
const FETCH_CONCURRENCY = 4; // 与 sendDueAlerts 的 mapWithConcurrency(4) 保持一致
const BACKFILL_START = "20200101"; // 回填起点（与 fetchStockSnapshot 的 beg 一致）
const INCREMENTAL_DAYS = 5; // 已入库的股票每次只 upsert 最近 N 个交易日（容忍数据源事后修正）
const DEFAULT_PERIOD = 20;
const MAX_PERIOD = 250;
const HISTORY_DEFAULT_DAYS = 120;
const HISTORY_MAX_DAYS = 500;
const HISTORY_CACHE_SECONDS = 600;
const SINA_BACKFILL_DATALEN = 1800; // 新浪单次最多返回的日线条数（约 7 年）
const SINA_INCREMENT_MARGIN = 60; // 增量模式多拉几十根，保证最长周期也能算出指标
const MEMO_TTL_SECONDS = 3 * 86_400;
const TIMEZONE = "Asia/Shanghai";

// 与 subscription-worker.js 的 WATCHLIST 键集合保持一致（默认自选，未登录用户看到的就是这些）。
const DEFAULT_WATCHLIST_CODES = [
  "688256", "688802", "688795", "600036", "300750",
  "00700", "01810", "09988", "03690", "00941",
  "AAPL", "MSFT", "NVDA", "TSLA", "GOOGL", "AMZN", "META",
];

// ---------------------------------------------------------------------------
// 通用小工具（有意与 subscription-worker.js 重复，换取模块零耦合）
// ---------------------------------------------------------------------------

function safeJsonParse(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry(urls, options = {}, label = "request") {
  const candidates = Array.isArray(urls) ? urls : [urls];
  let lastError;
  for (const url of candidates) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(url, options);
        if (!response.ok) throw new Error(`${label} returned ${response.status}`);
        return await response.json();
      } catch (err) {
        lastError = err;
        if (attempt === 0) await sleep(180);
      }
    }
  }
  throw lastError || new Error(`${label} failed`);
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    })
  );
  return results;
}

function normalizeSecurityCode(value) {
  const compact = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^0-9A-Z.-]/g, "");
  if (/^\d{1,5}$/.test(compact)) return compact.padStart(5, "0");
  if (/^\d{6}$/.test(compact)) return compact;
  const usSymbol = compact.replace(/\./g, "-");
  if (/^[A-Z](?:[A-Z0-9-]{0,8}[A-Z0-9])?$/.test(usSymbol)) return usSymbol;
  return "";
}

function isUsSymbol(code) {
  return /^[A-Z](?:[A-Z0-9-]{0,8}[A-Z0-9])?$/.test(String(code || ""));
}

function inferMarket(code) {
  const normalized = normalizeSecurityCode(code);
  if (isUsSymbol(normalized)) return "US";
  if (normalized.length === 5) return "116";
  return /^(5|6|688|689)/.test(normalized) ? "1" : "0";
}

function normalizePeriod(value, fallback = null) {
  const period = Number(value ?? fallback);
  return Number.isInteger(period) && period >= 2 && period <= MAX_PERIOD ? period : null;
}

function beijingToday(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function shiftCompactDate(compact, deltaDays) {
  const year = Number(compact.slice(0, 4));
  const month = Number(compact.slice(4, 6)) - 1;
  const day = Number(compact.slice(6, 8));
  return new Date(Date.UTC(year, month, day + deltaDays)).toISOString().slice(0, 10).replaceAll("-", "");
}

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

// ---------------------------------------------------------------------------
// 日线拉取（数据源选择照抄 fetchStockSnapshot：A股走新浪、港美股走雅虎）
// ---------------------------------------------------------------------------

function toSinaSymbol(code) {
  return `${inferMarket(code) === "1" ? "sh" : "sz"}${code}`;
}

function toYahooSymbol(code, market) {
  if (market === "116") return `${String(Number(code)).padStart(4, "0")}.HK`;
  if (market === "1") return `${code}.SS`;
  if (market === "0") return `${code}.SZ`;
  return code.replace(/\./g, "-");
}

function toUnixSecondsFromCompactDate(value, includeEnd = false) {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6)) - 1;
  const day = Number(value.slice(6, 8)) + (includeEnd ? 1 : 0);
  return Math.floor(Date.UTC(year, month, day, 0, 0, 0) / 1000);
}

function yahooDate(timestamp, gmtoffset = 0) {
  return new Date((timestamp + gmtoffset) * 1000).toISOString().slice(0, 10);
}

async function fetchSinaBars(code, datalen) {
  const rows = await fetchJsonWithRetry(
    `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData` +
      `?symbol=${toSinaSymbol(code)}&scale=240&ma=no&datalen=${datalen}`,
    { headers: { Accept: "application/json,text/plain,*/*" } },
    `${code} sina kline`
  );
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${code} 没有日线数据`);
  return rows
    .map((row) => ({
      date: String(row.day || "").slice(0, 10),
      open: numberOrNull(row.open),
      high: numberOrNull(row.high),
      low: numberOrNull(row.low),
      close: numberOrNull(row.close),
      volume: numberOrNull(row.volume),
      amount: null, // 新浪该接口不返回成交额
    }))
    .filter((bar) => /^\d{4}-\d{2}-\d{2}$/.test(bar.date) && Number.isFinite(bar.close));
}

async function fetchYahooBars(code, market, beg, end) {
  const params = new URLSearchParams({
    period1: String(toUnixSecondsFromCompactDate(beg)),
    period2: String(toUnixSecondsFromCompactDate(end, true)),
    interval: "1d",
    events: "history",
  });
  const symbol = toYahooSymbol(code, market);
  const payload = await fetchJsonWithRetry(
    [
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`,
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`,
    ],
    { headers: { Accept: "application/json,text/plain,*/*", "User-Agent": "Mozilla/5.0" } },
    `${code} yahoo kline`
  );
  const result = payload?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  const gmtoffset = result?.meta?.gmtoffset ?? 0;
  const bars = timestamps
    .map((timestamp, index) => {
      const close = numberOrNull(quote.close?.[index]);
      if (close === null) return null;
      return {
        date: yahooDate(timestamp, gmtoffset),
        open: numberOrNull(quote.open?.[index]),
        high: numberOrNull(quote.high?.[index]),
        low: numberOrNull(quote.low?.[index]),
        close,
        volume: numberOrNull(quote.volume?.[index]),
        amount: null,
      };
    })
    .filter(Boolean);
  if (bars.length === 0) throw new Error(`${code} 没有日线数据`);
  return bars;
}

/**
 * 拉取一只股票的日线，按日期升序、按日期去重。
 * @param {string} code 已 normalizeSecurityCode 的代码
 * @param {{ deep: boolean, maxPeriod: number }} opts deep=true 时回填 2020 年以来全量
 */
async function fetchDailyBars(code, { deep, maxPeriod }) {
  const today = beijingToday().replaceAll("-", "");
  const market = inferMarket(code);
  // 增量模式只需要「最近 INCREMENTAL_DAYS 天 + 最长周期」的窗口即可算出指标。
  const shallowBars = maxPeriod + INCREMENTAL_DAYS + SINA_INCREMENT_MARGIN;
  let bars;
  if (market === "116" || market === "US") {
    // 雅虎按自然日取区间，交易日约占 5/7，留足冗余。
    const beg = deep ? BACKFILL_START : shiftCompactDate(today, -Math.ceil(shallowBars * 1.6));
    bars = await fetchYahooBars(code, market, beg < BACKFILL_START ? BACKFILL_START : beg, today);
  } else {
    bars = await fetchSinaBars(code, deep ? SINA_BACKFILL_DATALEN : shallowBars);
  }
  const byDate = new Map();
  for (const bar of bars) {
    if (bar.date >= "2020-01-01") byDate.set(bar.date, bar);
  }
  const sorted = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (sorted.length === 0) throw new Error(`${code} 2020 年以来没有日线数据`);
  return sorted;
}

// ---------------------------------------------------------------------------
// 指标计算（口径与 subscription-worker.js 的 computeLatestBands 完全一致：
// 中线 = N 日收盘均值，标准差为总体标准差 —— 除以 N 而非 N-1）
// ---------------------------------------------------------------------------

/**
 * 为 bars[fromIndex..] 计算 period 日布林带指标。
 * bandwidth_pct 沿用计划中的列名，值为「上下轨全宽 / 中线」= 4σ/中线 的比值（×100 即百分数）。
 */
function computeIndicatorRows(bars, period, fromIndex) {
  const rows = [];
  const start = Math.max(fromIndex, period - 1);
  for (let i = start; i < bars.length; i += 1) {
    let sum = 0;
    for (let k = i - period + 1; k <= i; k += 1) sum += bars[k].close;
    const middle = sum / period;
    let variance = 0;
    for (let k = i - period + 1; k <= i; k += 1) variance += (bars[k].close - middle) ** 2;
    variance /= period;
    const stddev = Math.sqrt(variance);
    const close = bars[i].close;
    rows.push({
      trade_date: bars[i].date,
      period,
      close,
      middle,
      stddev,
      sigma_offset: stddev > 0 ? (close - middle) / stddev : null,
      bandwidth_pct: middle !== 0 ? (4 * stddev) / middle : null,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// D1 建表 / 写入
// ---------------------------------------------------------------------------

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS daily_bars (
     code TEXT NOT NULL,
     trade_date TEXT NOT NULL,
     close REAL NOT NULL,
     open REAL, high REAL, low REAL, volume REAL, amount REAL,
     PRIMARY KEY (code, trade_date)
   )`,
  `CREATE TABLE IF NOT EXISTS daily_indicators (
     code TEXT NOT NULL,
     trade_date TEXT NOT NULL,
     period INTEGER NOT NULL,
     close REAL NOT NULL,
     middle REAL NOT NULL,
     stddev REAL NOT NULL,
     sigma_offset REAL,
     bandwidth_pct REAL,
     PRIMARY KEY (code, trade_date, period)
   )`,
  `CREATE TABLE IF NOT EXISTS sector_daily (
     bk TEXT NOT NULL,
     trade_date TEXT NOT NULL,
     name TEXT,
     index_value REAL NOT NULL,
     member_count INTEGER,
     PRIMARY KEY (bk, trade_date)
   )`,
  `CREATE TABLE IF NOT EXISTS snapshot_runs (
     run_date TEXT PRIMARY KEY,
     started_at TEXT, finished_at TEXT,
     stocks_ok INTEGER, stocks_failed INTEGER,
     rows_written INTEGER, note TEXT
   )`,
];

const UPSERT_BAR = `INSERT INTO daily_bars (code, trade_date, close, open, high, low, volume, amount)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(code, trade_date) DO UPDATE SET
    close = excluded.close, open = excluded.open, high = excluded.high,
    low = excluded.low, volume = excluded.volume, amount = excluded.amount`;

const UPSERT_INDICATOR = `INSERT INTO daily_indicators
    (code, trade_date, period, close, middle, stddev, sigma_offset, bandwidth_pct)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(code, trade_date, period) DO UPDATE SET
    close = excluded.close, middle = excluded.middle, stddev = excluded.stddev,
    sigma_offset = excluded.sigma_offset, bandwidth_pct = excluded.bandwidth_pct`;

const UPSERT_SECTOR = `INSERT INTO sector_daily (bk, trade_date, name, index_value, member_count)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(bk, trade_date) DO UPDATE SET
    name = excluded.name, index_value = excluded.index_value, member_count = excluded.member_count`;

const UPSERT_RUN = `INSERT INTO snapshot_runs
    (run_date, started_at, finished_at, stocks_ok, stocks_failed, rows_written, note)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(run_date) DO UPDATE SET
    started_at = excluded.started_at, finished_at = excluded.finished_at,
    stocks_ok = excluded.stocks_ok, stocks_failed = excluded.stocks_failed,
    rows_written = excluded.rows_written, note = excluded.note`;

async function ensureSchema(env) {
  await env.DB.batch(SCHEMA_STATEMENTS.map((sql) => env.DB.prepare(sql)));
}

// 每批 ≤ BATCH_SIZE 条语句提交，返回实际提交的语句（行）数。
async function runBatched(env, statements) {
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    await env.DB.batch(statements.slice(i, i + BATCH_SIZE));
  }
  return statements.length;
}

// ---------------------------------------------------------------------------
// universe / 周期集合
// ---------------------------------------------------------------------------

async function listKvValues(env, prefix) {
  const values = [];
  let cursor;
  do {
    const page = await env.SUBSCRIPTIONS.list({ prefix, cursor });
    for (const key of page.keys) {
      values.push(safeJsonParse(await env.SUBSCRIPTIONS.get(key.name)));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return values.filter(Boolean);
}

/**
 * 快照范围 = 所有订阅/预警的 stocks ∪ 所有自选 codes ∪ 默认自选，归一化去重后截断到 MAX_UNIVERSE。
 * 周期集合 = {20} ∪ 各订阅的 period。
 */
async function collectUniverse(env) {
  const codes = new Set();
  const periods = new Set([DEFAULT_PERIOD]);
  const push = (value) => {
    const normalized = normalizeSecurityCode(value);
    if (normalized) codes.add(normalized);
  };

  if (env.SUBSCRIPTIONS) {
    for (const prefix of ["sub:", "alert:"]) {
      for (const record of await listKvValues(env, prefix)) {
        for (const code of Array.isArray(record.stocks) ? record.stocks : []) push(code);
        const period = normalizePeriod(record.period);
        if (period) periods.add(period);
      }
    }
    for (const record of await listKvValues(env, "watchlist:")) {
      for (const code of Array.isArray(record.codes) ? record.codes : []) push(code);
    }
  }
  for (const code of DEFAULT_WATCHLIST_CODES) push(code);

  const all = [...codes];
  const kept = all.slice(0, MAX_UNIVERSE);
  if (all.length > kept.length) {
    console.warn(
      `[snapshot] universe ${all.length} 只超过上限 ${MAX_UNIVERSE}，丢弃：${all.slice(MAX_UNIVERSE).join(",")}`
    );
  }
  return { codes: kept, periods: [...periods].sort((a, b) => a - b), dropped: all.length - kept.length };
}

// ---------------------------------------------------------------------------
// 单只股票落库
// ---------------------------------------------------------------------------

const backfillMemoKey = (code) => `snap:bf:${code}`;

// 是否已完成回填：优先看 KV memo（回填全部批次成功后才写），KV 不可用时退回 D1 计数。
async function isBackfilled(env, code) {
  try {
    if (env.SUBSCRIPTIONS) {
      const memo = await env.SUBSCRIPTIONS.get(backfillMemoKey(code));
      if (memo) return true;
    }
  } catch (err) {
    console.warn(`[snapshot] backfill memo read failed ${code}:`, err?.message || err);
  }
  const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM daily_bars WHERE code = ?").bind(code).first();
  return Number(row?.c || 0) > 0;
}

/**
 * 落库一只股票，返回本次写入的行数。
 * 首次入库 → 回填 2020 年以来全量；已入库 → 只 upsert 最近 INCREMENTAL_DAYS 个交易日。
 */
async function persistStock(env, code, periods, budget) {
  const deep = !(await isBackfilled(env, code));
  const maxPeriod = periods[periods.length - 1] || DEFAULT_PERIOD;
  const bars = await fetchDailyBars(code, { deep, maxPeriod });

  const fromIndex = deep ? 0 : Math.max(0, bars.length - INCREMENTAL_DAYS);
  const barsToWrite = bars.slice(fromIndex);
  const statements = barsToWrite.map((bar) =>
    env.DB.prepare(UPSERT_BAR).bind(code, bar.date, bar.close, bar.open, bar.high, bar.low, bar.volume, bar.amount)
  );
  for (const period of periods) {
    if (bars.length < period) continue;
    for (const row of computeIndicatorRows(bars, period, fromIndex)) {
      statements.push(
        env.DB
          .prepare(UPSERT_INDICATOR)
          .bind(code, row.trade_date, row.period, row.close, row.middle, row.stddev, row.sigma_offset, row.bandwidth_pct)
      );
    }
  }
  // 预算不够放下整只股票 → 整只跳过，避免半截写入；下次 cron 自动续跑。
  // 例外：本次运行还一行没写时无条件写入，否则单只股票大于总预算会永远卡住。
  if (statements.length > budget.remaining() && budget.spent() > 0) {
    return { written: 0, skippedForBudget: true };
  }

  const written = await runBatched(env, statements);
  budget.spend(written);
  if (deep && env.SUBSCRIPTIONS) {
    // 全部批次成功后才落 memo：中途失败下次仍会重新回填。
    await env.SUBSCRIPTIONS.put(backfillMemoKey(code), bars[0].date).catch((err) =>
      console.warn(`[snapshot] backfill memo write failed ${code}:`, err?.message || err)
    );
  }
  return { written, skippedForBudget: false };
}

// ---------------------------------------------------------------------------
// 导出 1：每日快照
// ---------------------------------------------------------------------------

/**
 * 采集并落库当日（或首次运行时的全量历史）个股快照。永不 throw。
 * @param {object} env Worker 环境；缺 env.DB 时整体 no-op
 * @param {{ force?: boolean }} opts force=true 跳过 KV 防重（手动触发用）
 * @returns {Promise<object|null>} 本次运行摘要；未启用时返回 null
 */
export async function runDailySnapshot(env, opts = {}) {
  try {
    if (!env?.DB) return null;
    const runDate = beijingToday();
    const memoKey = `snap:done:${runDate}`;
    // cron 每分钟触发，16:00–16:02 容错窗内会进来 3 次，靠 memo 只跑一次；
    // upsert 本身幂等，memo 只是省流量的兜底。
    if (!opts.force && env.SUBSCRIPTIONS) {
      const done = await env.SUBSCRIPTIONS.get(memoKey).catch(() => null);
      if (done) return { runDate, skipped: "already done" };
    }

    const startedAt = new Date().toISOString();
    await ensureSchema(env);
    const { codes, periods, dropped } = await collectUniverse(env);

    let spent = 0;
    // 上限默认 MAX_ROWS_PER_RUN，可用环境变量 SNAPSHOT_MAX_ROWS 覆盖（验收 §8 的截停验证用）。
    const maxRows = Number(env.SNAPSHOT_MAX_ROWS) > 0 ? Number(env.SNAPSHOT_MAX_ROWS) : MAX_ROWS_PER_RUN;
    const budget = {
      spent: () => spent,
      remaining: () => maxRows - spent,
      spend: (rows) => {
        spent += rows;
      },
    };

    let ok = 0;
    let failed = 0;
    let budgetSkipped = 0;
    // 单只股票失败 warn 后继续（照抄 sendDueAlerts 的逐项兜底风格），不拖垮批次。
    await mapWithConcurrency(codes, FETCH_CONCURRENCY, async (code) => {
      try {
        const result = await persistStock(env, code, periods, budget);
        if (result.skippedForBudget) budgetSkipped += 1;
        else ok += 1;
      } catch (err) {
        failed += 1;
        console.warn(`[snapshot] ${code} failed:`, err?.message || err);
      }
    });

    const note = [
      `codes=${codes.length}`,
      `periods=${periods.join("/")}`,
      dropped ? `dropped=${dropped}` : "",
      budgetSkipped ? `budgetSkipped=${budgetSkipped}` : "",
      opts.force ? "manual" : "cron",
    ]
      .filter(Boolean)
      .join(" ");
    const finishedAt = new Date().toISOString();
    await env.DB.prepare(UPSERT_RUN).bind(runDate, startedAt, finishedAt, ok, failed, spent, note).run();

    // 还有股票因预算被跳过时不写 memo，让下一次 cron 继续跑完。
    if (env.SUBSCRIPTIONS && budgetSkipped === 0) {
      await env.SUBSCRIPTIONS.put(memoKey, finishedAt, { expirationTtl: MEMO_TTL_SECONDS }).catch(() => {});
    }
    return {
      run_date: runDate,
      started_at: startedAt,
      finished_at: finishedAt,
      stocks_ok: ok,
      stocks_failed: failed,
      rows_written: spent,
      note,
    };
  } catch (err) {
    console.warn("[snapshot] run failed:", err?.message || err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 导出 2：板块合成指数落库
// ---------------------------------------------------------------------------

/**
 * 由 refreshSectorBollinger 的 payload 计算每日板块合成指数并落库。永不 throw。
 *
 * 合成口径：**等权算术平均收盘价**（当日所有有收盘价的成分股收盘价的简单平均）。
 * 说明：sectors.html 目前只逐只展示成分股的布林带，前端并不存在「板块合成指数」，
 * 因此无既有口径可对齐。选等权平均而非市值加权，是因为 payload 里的 mcap 只有
 * 「当日快照」一个值，用它做权重会让同一交易日的指数值随运行日漂移，破坏时序可比性；
 * 等权平均对给定 (bk, trade_date, 成分集合) 完全确定，重复运行结果一致。
 * 成分集合变化会导致指数跳变，用 member_count 列可以识别。
 */
export async function persistSectorSnapshot(env, payload) {
  try {
    if (!env?.DB) return null;
    const bk = String(payload?.bk || "");
    const dates = Array.isArray(payload?.dates) ? payload.dates : [];
    const stocks = Array.isArray(payload?.stocks) ? payload.stocks : [];
    if (!bk || dates.length === 0 || stocks.length === 0) return null;

    await ensureSchema(env);

    // payload.stocks[].closes 长度可能短于公共横轴（停牌/次新），按「最后一根对齐最新日期」右对齐。
    const sums = new Array(dates.length).fill(0);
    const counts = new Array(dates.length).fill(0);
    for (const stock of stocks) {
      const closes = Array.isArray(stock?.closes) ? stock.closes : [];
      const offset = dates.length - closes.length;
      if (offset < 0) continue;
      for (let i = 0; i < closes.length; i += 1) {
        const close = Number(closes[i]);
        if (!Number.isFinite(close)) continue;
        sums[offset + i] += close;
        counts[offset + i] += 1;
      }
    }

    const rows = dates
      .map((date, i) => ({ date: String(date).slice(0, 10), index: counts[i] ? sums[i] / counts[i] : null, members: counts[i] }))
      .filter((row) => row.index !== null && /^\d{4}-\d{2}-\d{2}$/.test(row.date));
    if (rows.length === 0) return null;

    const existing = await env.DB.prepare("SELECT COUNT(*) AS c FROM sector_daily WHERE bk = ?").bind(bk).first();
    const toWrite = Number(existing?.c || 0) > 0 ? rows.slice(-INCREMENTAL_DAYS) : rows;
    const name = payload?.name ? String(payload.name) : null;
    const written = await runBatched(
      env,
      toWrite.map((row) => env.DB.prepare(UPSERT_SECTOR).bind(bk, row.date, name, row.index, row.members))
    );
    return { bk, rows_written: written };
  } catch (err) {
    console.warn("[snapshot] sector persist failed:", err?.message || err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 导出 3：历史查询 API
// ---------------------------------------------------------------------------

// 表还没建起来时 D1 抛的是 SQLite 的 "no such table: xxx"，与「查不到数据」等价。
function isMissingTableError(err) {
  const message = String(err?.cause?.message || err?.message || err);
  return /no such table/i.test(message);
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      ...extraHeaders,
    },
  });
}

/**
 * GET /api/snapshot-history?code=600183&period=20&days=120
 * 从 daily_indicators 按日期升序返回指标序列。永不 throw。
 */
export async function handleSnapshotHistory(request, env) {
  try {
    if (!env?.DB) return jsonResponse({ error: "snapshot 功能未启用" }, 503);
    const url = new URL(request.url);
    const code = normalizeSecurityCode(url.searchParams.get("code"));
    if (!code) return jsonResponse({ error: "code 参数无效" }, 400);

    const periodRaw = url.searchParams.get("period");
    const period = normalizePeriod(periodRaw ?? DEFAULT_PERIOD, DEFAULT_PERIOD);
    if (!period) return jsonResponse({ error: "period 参数无效（2–250）" }, 400);

    const daysRaw = url.searchParams.get("days");
    const days = daysRaw === null ? HISTORY_DEFAULT_DAYS : Number(daysRaw);
    if (!Number.isInteger(days) || days < 1 || days > HISTORY_MAX_DAYS) {
      return jsonResponse({ error: `days 参数无效（1–${HISTORY_MAX_DAYS}）` }, 400);
    }

    // 先按日期倒序取最近 days 条，再翻回升序返回。
    // 全新 D1 在第一次快照跑完之前还没有建表（建表只发生在 runDailySnapshot /
    // persistSectorSnapshot 里），此时查一个还没入库的代码语义上就是「没有数据」，
    // 应当返回 200 + 空数组，而不是把 SQLite 的 "no such table" 冒泡成 500。
    let result;
    try {
      result = await env.DB
        .prepare(
          `SELECT trade_date, close, middle, stddev, sigma_offset, bandwidth_pct
             FROM daily_indicators
            WHERE code = ? AND period = ?
            ORDER BY trade_date DESC
            LIMIT ?`
        )
        .bind(code, period, days)
        .all();
    } catch (err) {
      if (!isMissingTableError(err)) throw err;
      result = null;
    }
    const rows = (result?.results || []).slice().reverse();
    return jsonResponse({ code, period, days, rows }, 200, {
      "Cache-Control": `public, max-age=${HISTORY_CACHE_SECONDS}`,
    });
  } catch (err) {
    console.warn("[snapshot] history query failed:", err?.message || err);
    return jsonResponse({ error: "查询失败" }, 500);
  }
}
