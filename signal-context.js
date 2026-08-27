// 历史信号上下文模块（独立、只读、失败即降级）。
//
// 设计约束（与 ai-interpreter.js / snapshot-store.js 同源）：
// 1. 零依赖，只用 Worker 原生 API；本文件不 import subscription-worker.js，
//    所需的通用小工具在此重新实现，以保证「新模块任何情况下不影响现有功能」。
// 2. 三个导出永不 throw：任何异常路径都吞掉并记 warn，调用方拿到 null。
// 3. 未绑定 D1（env.DB 缺失）、查询失败、历史行数不足 → 信号整体为 null，
//    邮件与未接入本模块时逐字节一致，AI 解读退回无历史上下文的旧行为。
// 4. 只读：只 SELECT 现有的 daily_indicators，不建表、不写库、不动 KV。

const DEFAULT_PERIOD = 20;
const MAX_PERIOD = 250;
// 单只股票一次取多少行历史。σ偏离分位口径是 250 个交易日（约一年），取满即可，
// 其余窗口（120 日带宽分位、5 日带宽变化）都是它的子集，无需二次查询。
const HISTORY_LIMIT = 250;
// 行数少于这个值就整条置 null：新回填的库、刚加的自选，宁缺毋滥不给误导性分位。
const MIN_DATA_DAYS = 30;
const BANDWIDTH_WINDOW = 120; // 带宽分位窗口（交易日）
const SIGMA_WINDOW = 250; // σ偏离分位窗口（交易日）
const BANDWIDTH_LOOKBACK = 5; // 带宽变化率回看的交易日数
const QUERY_CONCURRENCY = 4; // 与 sendDueAlerts 的 mapWithConcurrency(4) 保持一致
const ENDPOINT_CACHE_SECONDS = 600;
const SIDE_ABOVE = "高于上轨";
const SIDE_BELOW = "低于下轨";
const DISCLAIMER = "基于每日快照库计算，仅描述历史统计，不构成投资建议。";

const HISTORY_SQL = `SELECT trade_date, sigma_offset, bandwidth_pct
     FROM daily_indicators
    WHERE code = ? AND period = ?
    ORDER BY trade_date DESC
    LIMIT ?`;

// ---------------------------------------------------------------------------
// 通用小工具（有意与 subscription-worker.js / snapshot-store.js 重复，换取模块零耦合）
// ---------------------------------------------------------------------------

// 注意 Number(null) === 0：D1 里 sigma_offset / bandwidth_pct 是可空列
// （stddev 为 0、middle 为 0 时 snapshot-store 就写 NULL），
// 必须先把 null/undefined/"" 挡掉，否则会被当成真实的 0 去参与分位与连续天数计算。
function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizePeriod(value, fallback = null) {
  const period = Number(value ?? fallback);
  return Number.isInteger(period) && period >= 2 && period <= MAX_PERIOD ? period : null;
}

function normalizeMultiplier(value, fallback = 2) {
  const multiplier = Number(value ?? fallback);
  return Number.isFinite(multiplier) && multiplier > 0 ? multiplier : null;
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

// 全新 D1 在第一次快照跑完之前还没有建表（建表只发生在 snapshot-store 里），
// 此时查一个还没入库的代码语义上就是「没有数据」，不该冒泡成错误。
function isMissingTableError(err) {
  const message = String(err?.cause?.message || err?.message || err);
  return /no such table/i.test(message);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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

// ---------------------------------------------------------------------------
// 派生信号计算（纯函数，全部在内存里算，不再回查 D1）
// rows 一律是 trade_date 倒序（最新在前）的原始查询结果。
// ---------------------------------------------------------------------------

/**
 * 连续触轨天数：从最新日往回数，按 direction 方向连续满足 |sigma_offset| >= multiplier 的天数。
 * direction >= 0 数 sigma_offset >= multiplier（高于上轨），否则数 <= -multiplier（低于下轨）。
 * 最新一天就不满足（含跨到另一侧）→ 0。
 */
function computeStreakDays(rows, direction, multiplier) {
  if (multiplier === null) return null;
  let streak = 0;
  for (const row of rows) {
    const sigma = numberOrNull(row?.sigma_offset);
    if (sigma === null) break;
    const hit = direction >= 0 ? sigma >= multiplier : sigma <= -multiplier;
    if (!hit) break;
    streak += 1;
  }
  return streak;
}

/** 带宽 5 日变化率：(最新 / 5 个交易日前 - 1)。正=放大，负=收窄。 */
function computeBandwidthChange(rows, lookback) {
  const latest = numberOrNull(rows[0]?.bandwidth_pct);
  const prior = rows.length > lookback ? numberOrNull(rows[lookback]?.bandwidth_pct) : null;
  if (latest === null || prior === null || prior === 0) return null;
  return latest / prior - 1;
}

/**
 * target 在 sample 中的分位（0–100）。
 * 口径：(严格小于的个数 + 相等个数的一半) / 样本量。target 自身包含在样本内，
 * 因此窗口最小值落在 0 附近、最大值落在 100 附近。
 */
function percentileOf(sample, target) {
  if (target === null) return null;
  let less = 0;
  let equal = 0;
  let total = 0;
  for (const value of sample) {
    if (value === null) continue;
    total += 1;
    if (value < target) less += 1;
    else if (value === target) equal += 1;
  }
  if (total === 0) return null;
  return ((less + equal / 2) / total) * 100;
}

function columnWindow(rows, column, size, transform = (value) => value) {
  const window = [];
  for (let i = 0; i < rows.length && i < size; i += 1) {
    const value = numberOrNull(rows[i]?.[column]);
    window.push(value === null ? null : transform(value));
  }
  return window;
}

/** rows（倒序）→ SignalEntry；行数不足或最新行无效时返回 null。 */
function buildEntry(code, rows, direction, multiplier) {
  if (!Array.isArray(rows) || rows.length < MIN_DATA_DAYS) return null;
  const latest = rows[0];
  const asOf = latest?.trade_date ? String(latest.trade_date) : null;
  if (!asOf) return null;

  const latestBandwidth = numberOrNull(latest.bandwidth_pct);
  const latestSigma = numberOrNull(latest.sigma_offset);

  return {
    code,
    asOf,
    streakDays: computeStreakDays(rows, direction, multiplier),
    bandwidthChg5d: computeBandwidthChange(rows, BANDWIDTH_LOOKBACK),
    bandwidthPctile120: percentileOf(
      columnWindow(rows, "bandwidth_pct", BANDWIDTH_WINDOW),
      latestBandwidth
    ),
    sigmaPctile250: percentileOf(
      columnWindow(rows, "sigma_offset", SIGMA_WINDOW, Math.abs),
      latestSigma === null ? null : Math.abs(latestSigma)
    ),
    dataDays: rows.length,
  };
}

// ---------------------------------------------------------------------------
// D1 只读查询
// ---------------------------------------------------------------------------

async function queryHistory(env, code, period) {
  try {
    const result = await env.DB.prepare(HISTORY_SQL).bind(code, period, HISTORY_LIMIT).all();
    return result?.results || [];
  } catch (err) {
    if (isMissingTableError(err)) return [];
    console.warn(`[signal-context] query failed ${code}:`, err?.message || err);
    return null;
  }
}

/**
 * 触发方向：alert.side 优先；没有 side（如只读端点构造的伪 alert）时按最新 sigma_offset 的符号取当前侧。
 */
function directionFor(side, rows) {
  if (side === SIDE_ABOVE) return 1;
  if (side === SIDE_BELOW) return -1;
  const latestSigma = numberOrNull(rows?.[0]?.sigma_offset);
  return latestSigma === null || latestSigma >= 0 ? 1 : -1;
}

/**
 * 为一批预警构造历史信号上下文。**永不 throw。**
 * @returns {Promise<{byCode: Object, generatedAt: string}|null>} 完全不可用（无 DB / 无数据 / 全部算不出）时返回 null。
 */
export async function buildSignalContext(env, alerts, period) {
  try {
    if (!env?.DB || !Array.isArray(alerts) || alerts.length === 0) return null;
    const resolvedPeriod = normalizePeriod(period, DEFAULT_PERIOD) ?? DEFAULT_PERIOD;

    // 同一 code 多条预警时只查一次，方向/倍数取第一条。
    const targets = new Map();
    for (const alert of alerts) {
      const code = normalizeSecurityCode(alert?.code);
      if (!code || targets.has(code)) continue;
      targets.set(code, {
        code,
        side: alert?.side,
        multiplier: normalizeMultiplier(alert?.multiplier),
      });
    }
    if (targets.size === 0) return null;

    const list = [...targets.values()];
    const entries = await mapWithConcurrency(list, QUERY_CONCURRENCY, async (target) => {
      const rows = await queryHistory(env, target.code, resolvedPeriod);
      if (rows === null) return null;
      return buildEntry(target.code, rows, directionFor(target.side, rows), target.multiplier);
    });

    const byCode = {};
    let usable = 0;
    list.forEach((target, index) => {
      const entry = entries[index] || null;
      byCode[target.code] = entry;
      if (entry) usable += 1;
    });
    if (usable === 0) return null;
    return { byCode, generatedAt: new Date().toISOString() };
  } catch (err) {
    console.warn("[signal-context] build failed:", err?.message || err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 邮件渲染（纯代码格式化 + HTML 转义，不经过任何模型）
// ---------------------------------------------------------------------------

function formatSignedPercent(ratio) {
  const percent = ratio * 100;
  const rounded = Math.round(percent * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${rounded > 0 ? "+" : ""}${text}%`;
}

function describeEntry(entry, alert) {
  const parts = [];
  const name = alert?.name ? `${alert.name} ${entry.code}` : entry.code;
  parts.push(name);

  if (Number.isFinite(entry.streakDays) && entry.streakDays >= 1) {
    const side = alert?.side === SIDE_BELOW ? SIDE_BELOW : alert?.side === SIDE_ABOVE ? SIDE_ABOVE : "触轨";
    parts.push(`连续第 ${entry.streakDays} 日${side}`);
  }

  if (entry.bandwidthChg5d !== null && entry.bandwidthChg5d !== undefined) {
    const trend = entry.bandwidthChg5d < 0 ? "收窄" : entry.bandwidthChg5d > 0 ? "放大" : "持平";
    const pctile =
      entry.bandwidthPctile120 === null || entry.bandwidthPctile120 === undefined
        ? ""
        : `，${Math.min(entry.dataDays, BANDWIDTH_WINDOW)} 日分位 ${Math.round(entry.bandwidthPctile120)}%`;
    parts.push(`带宽 5 日 ${formatSignedPercent(entry.bandwidthChg5d)}（${trend}${pctile}）`);
  } else if (entry.bandwidthPctile120 !== null && entry.bandwidthPctile120 !== undefined) {
    parts.push(
      `带宽处近 ${Math.min(entry.dataDays, BANDWIDTH_WINDOW)} 日 ${Math.round(entry.bandwidthPctile120)}% 分位`
    );
  }

  if (entry.sigmaPctile250 !== null && entry.sigmaPctile250 !== undefined) {
    parts.push(
      `偏离度处近 ${Math.min(entry.dataDays, SIGMA_WINDOW)} 日 ${Math.round(entry.sigmaPctile250)}% 分位`
    );
  }

  parts.push(`数据 ${entry.dataDays} 日`);
  // 只有「名字 + 数据 N 日」两段时说明什么都没算出来，不值得占一行。
  if (parts.length <= 2) return null;
  return parts.map((part) => escapeHtml(part)).join(" · ");
}

/**
 * 渲染"历史信号"邮件区块。**永不 throw。**
 * @returns {string|null} HTML 片段；null 表示不插入该区块（邮件与未接入时逐字节一致）。
 */
export function renderSignalContextHtml(context, alerts) {
  try {
    const byCode = context?.byCode;
    if (!byCode || !Array.isArray(alerts) || alerts.length === 0) return null;

    const seen = new Set();
    const lines = [];
    for (const alert of alerts) {
      const code = normalizeSecurityCode(alert?.code);
      if (!code || seen.has(code)) continue;
      seen.add(code);
      const entry = byCode[code];
      if (!entry) continue;
      const line = describeEntry(entry, alert);
      if (line) lines.push(`<li style="margin:0 0 6px;">${line}</li>`);
    }
    if (lines.length === 0) return null;

    return `
      <div style="margin:16px 0;padding:14px 16px;border:1px solid #cbd5f5;border-left:4px solid #0f766e;border-radius:6px;background:#f8fafc;font-size:13px;line-height:1.7;color:#172033;">
        <div style="font-weight:600;margin-bottom:8px;">历史信号（近一年）</div>
        <ul style="margin:0;padding-left:18px;">${lines.join("")}</ul>
        <p style="margin:10px 0 0;color:#94a3b8;font-size:12px;">${escapeHtml(DISCLAIMER)}</p>
      </div>
  `;
  } catch (err) {
    console.warn("[signal-context] render failed:", err?.message || err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 只读端点 GET /api/signal-context?code=&period=&multiplier=
// ---------------------------------------------------------------------------

export async function handleSignalContext(request, env) {
  try {
    if (!env?.DB) return jsonResponse({ error: "signal-context 功能未启用" }, 503);
    const url = new URL(request.url);
    const code = normalizeSecurityCode(url.searchParams.get("code"));
    if (!code) return jsonResponse({ error: "code 参数无效" }, 400);

    const periodRaw = url.searchParams.get("period");
    const period = normalizePeriod(periodRaw ?? DEFAULT_PERIOD, DEFAULT_PERIOD);
    if (!period) return jsonResponse({ error: "period 参数无效（2–250）" }, 400);

    const multiplierRaw = url.searchParams.get("multiplier");
    const multiplier = normalizeMultiplier(multiplierRaw ?? 2, 2);
    if (multiplier === null) return jsonResponse({ error: "multiplier 参数无效（需为正数）" }, 400);

    // 方向不由调用方指定：伪 alert 不带 side，buildSignalContext 按最新 sigma_offset 的符号取当前侧。
    const context = await buildSignalContext(env, [{ code, multiplier }], period);
    const entry = context?.byCode?.[code] || null;
    return jsonResponse({ code, period, entry }, 200, {
      "Cache-Control": `public, max-age=${ENDPOINT_CACHE_SECONDS}`,
    });
  } catch (err) {
    console.warn("[signal-context] endpoint failed:", err?.message || err);
    return jsonResponse({ error: "查询失败" }, 500);
  }
}
