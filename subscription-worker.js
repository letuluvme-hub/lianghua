const WATCHLIST = {
  "688256": { name: "寒武纪" },
  "688802": { name: "沐曦股份" },
  "688795": { name: "摩尔线程" },
  "600036": { name: "招商银行" },
  "300750": { name: "宁德时代" },
  "00700": { name: "腾讯控股" },
  "01810": { name: "小米集团-W" },
  "09988": { name: "阿里巴巴-W" },
  "03690": { name: "美团-W" },
  "00941": { name: "中国移动" },
  AAPL: { name: "\u82f9\u679c" },
  MSFT: { name: "\u5fae\u8f6f" },
  NVDA: { name: "\u82f1\u4f1f\u8fbe" },
  TSLA: { name: "\u7279\u65af\u62c9" },
  GOOGL: { name: "\u8c37\u6b4cA" },
  AMZN: { name: "\u4e9a\u9a6c\u900a" },
  META: { name: "Meta" },
};

const MULTIPLIERS = [1, 2, 3];
const DEFAULT_PERIOD = 20;
const TIMEZONE = "Asia/Shanghai";
const LOGIN_CODE_TTL_SECONDS = 10 * 60;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_WATCHLIST_CODES = Object.keys(WATCHLIST);
const SECURITY_NAME_CACHE = new Map();
const ALERT_CONDITIONS = {
  outside: "高于上轨或低于下轨",
  above: "高于上轨",
  below: "低于下轨",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
    },
  });
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function safeJsonParse(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function makeRandomDigits(length = 6) {
  const values = new Uint32Array(length);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => String(value % 10)).join("");
}

function makeSessionToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function getBearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function requireUser(request, env) {
  const token = getBearerToken(request);
  if (!token) return { response: json({ error: "请先登录后再操作。" }, 401) };

  const session = safeJsonParse(await env.SUBSCRIPTIONS.get(`session:${token}`));
  if (!session?.email || !session?.expiresAt) return { response: json({ error: "登录状态已失效，请重新登录。" }, 401) };
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    await env.SUBSCRIPTIONS.delete(`session:${token}`);
    return { response: json({ error: "登录状态已过期，请重新登录。" }, 401) };
  }

  return { token, email: session.email };
}

function inferMarket(code) {
  const normalized = normalizeSecurityCode(code);
  if (isUsSymbol(normalized)) return "US";
  if (normalized.length === 5) return "116";
  return /^(5|6|688|689)/.test(normalized) ? "1" : "0";
}

function formatNumber(value) {
  return Number(value).toFixed(2);
}

function normalizePeriod(value, fallback = null) {
  const period = Number(value ?? fallback);
  return Number.isInteger(period) && period >= 2 && period <= 250 ? period : null;
}

function formatSigma(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "--";
  return `${numeric >= 0 ? "+" : ""}${numeric.toFixed(2)}σ`;
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

function sanitizeStockCodes(value) {
  return Array.isArray(value)
    ? [...new Set(value.map(normalizeSecurityCode).filter(Boolean))]
    : [];
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

async function klineCache(request, loader) {
  const cache = typeof caches === "undefined" ? null : caches.default;
  if (cache) {
    const cached = await cache.match(request);
    if (cached) return cached;
  }

  const response = await loader();
  if (cache && response.ok) {
    // 叠加了实时报价，缓存压到 30s，盘中价格基本即时刷新（原 300s 会让“实时价”最多滞后 5 分钟）。
    response.headers.set("Cache-Control", "public, max-age=30");
    await cache.put(request, response.clone());
  }
  return response;
}

async function fetchSecurityName(code, marketMode = "auto") {
  if (WATCHLIST[code]?.name) return WATCHLIST[code].name;
  const cached = SECURITY_NAME_CACHE.get(code);
  if (cached) return cached;

  const primaryMarket = marketMode === "auto" ? inferMarket(code) : marketMode;
  if (primaryMarket === "US" || isUsSymbol(code)) {
    const name = await fetchYahooSecurityName(code, "US").catch(() => "");
    if (name) {
      SECURITY_NAME_CACHE.set(code, name);
      return name;
    }
    return code;
  }

  const markets = primaryMarket === "116" ? ["116"] : primaryMarket === "1" ? ["1", "0"] : ["0", "1"];
  for (const market of markets) {
    try {
      const params = new URLSearchParams({
        secid: `${market}.${code}`,
        fields: "f57,f58,f107",
      });
      const payload = await fetchJsonWithRetry(
        `https://push2.eastmoney.com/api/qt/stock/get?${params}`,
        { headers: { Accept: "application/json,text/plain,*/*" } },
        `${code} name lookup`
      );
      const name = String(payload?.data?.f58 || "").trim();
      if (name && name !== "-") {
        SECURITY_NAME_CACHE.set(code, name);
        return name;
      }
    } catch {
      // Name lookup is best-effort; k-line data should still render without it.
    }
  }

  return code;
}

async function publicStocks(codes) {
  return mapWithConcurrency(
    sanitizeStockCodes(codes),
    4,
    async (code) => ({
      code,
      name: await fetchSecurityName(code),
    })
  );
}

function currentShanghaiParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23", // hour12:false 在部分运行时把午夜格式化成 "24:00"，导致 sendTime "00:xx" 永远匹配不上
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

function parseKline(row) {
  const parts = row.split(",");
  return {
    date: parts[0],
    close: Number(parts[2]),
  };
}

function computeLatestBands(rows, period = DEFAULT_PERIOD) {
  const safePeriod = normalizePeriod(period, DEFAULT_PERIOD);
  if (!safePeriod || rows.length < safePeriod) return null;
  const windowRows = rows.slice(-safePeriod);
  const middle = windowRows.reduce((sum, row) => sum + row.close, 0) / safePeriod;
  const variance = windowRows.reduce((sum, row) => sum + (row.close - middle) ** 2, 0) / safePeriod;
  const standardDeviation = Math.sqrt(variance);
  const bands = Object.fromEntries(
    MULTIPLIERS.map((multiplier) => [
      multiplier,
      {
        upper: middle + multiplier * standardDeviation,
        lower: middle - multiplier * standardDeviation,
      },
    ])
  );

  return {
    date: rows.at(-1).date,
    close: rows.at(-1).close,
    middle,
    standardDeviation,
    bands,
  };
}

async function fetchStockSnapshot(code, period) {
  const end = currentShanghaiParts().date.replaceAll("-", "");
  const normalizedCode = normalizeSecurityCode(code);
  const market = inferMarket(normalizedCode);
  const payload =
    market === "116" || market === "US"
      ? await fetchYahooKlines({ code: normalizedCode, marketMode: market, beg: "20200101", end })
      : await fetchSinaKlines({ code: normalizedCode, marketMode: "auto", beg: "20200101", end });
  const rows = payload.data.klines.map(parseKline);
  const bands = computeLatestBands(rows, period);
  if (!bands) throw new Error(`${normalizedCode} 日线数量不足以计算 ${period} 日布林带`);
  return {
    code: normalizedCode,
    name: payload.data.name || (await fetchSecurityName(code)),
    ...bands,
  };
}

async function fetchEastmoneyKlines({ code, marketMode = "auto", adjust = "1", beg, end }) {
  const normalizedCode = normalizeSecurityCode(code);
  const market = marketMode === "auto" ? inferMarket(normalizedCode) : marketMode;
  const params = new URLSearchParams({
    secid: `${market}.${normalizedCode}`,
    fields1: "f1,f2,f3,f4,f5,f6",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
    klt: "101",
    fqt: adjust,
    beg,
    end,
  });
  const payload = await fetchJsonWithRetry(
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?${params}`,
    { headers: { Accept: "application/json,text/plain,*/*" } },
    `${normalizedCode} eastmoney kline`
  );
  if (!payload.data?.klines?.length) throw new Error(`${normalizedCode} 没有日线数据`);
  payload.data.name = payload.data.name || (await fetchSecurityName(normalizedCode, marketMode));
  return payload;
}

function toSinaSymbol(code, marketMode = "auto") {
  const normalizedCode = normalizeSecurityCode(code);
  const market = marketMode === "auto" ? inferMarket(normalizedCode) : marketMode;
  return `${market === "1" ? "sh" : "sz"}${normalizedCode}`;
}

function formatSinaDate(date) {
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

function toYahooSymbol(code, marketMode = "auto") {
  const normalizedCode = normalizeSecurityCode(code);
  const market = marketMode === "auto" ? inferMarket(normalizedCode) : marketMode;
  if (market === "116") return `${String(Number(normalizedCode)).padStart(4, "0")}.HK`;
  if (market === "1") return `${normalizedCode}.SS`;
  if (market === "0") return `${normalizedCode}.SZ`;
  return normalizedCode.replace(/\./g, "-");
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

async function fetchYahooSecurityName(code, marketMode = "auto") {
  const symbol = toYahooSymbol(code, marketMode);
  const urls = [
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`,
    `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`,
  ];
  const payload = await fetchJsonWithRetry(
    urls,
    { headers: { Accept: "application/json,text/plain,*/*", "User-Agent": "Mozilla/5.0" } },
    `${code} yahoo quote`
  );
  const result = payload?.quoteResponse?.result?.[0];
  return String(result?.shortName || result?.longName || result?.displayName || "").trim();
}

async function fetchYahooKlines({ code, marketMode = "auto", beg, end, proportional = false }) {
  const market = marketMode === "auto" ? inferMarket(code) : marketMode;
  const symbol = toYahooSymbol(code, market);
  const params = new URLSearchParams({
    period1: String(toUnixSecondsFromCompactDate(beg)),
    period2: String(toUnixSecondsFromCompactDate(end, true)),
    interval: "1d",
    events: "history",
  });
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`,
  ];
  const payload = await fetchJsonWithRetry(
    urls,
    { headers: { Accept: "application/json,text/plain,*/*", "User-Agent": "Mozilla/5.0" } },
    `${code} yahoo kline`
  );
  const result = payload?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  const adjcloseArr = result?.indicators?.adjclose?.[0]?.adjclose || [];
  const gmtoffset = result?.meta?.gmtoffset ?? 0;
  const klines = timestamps
    .map((timestamp, index) => {
      const rawClose = quote.close?.[index];
      if (!Number.isFinite(rawClose)) return null;
      const rawOpen = quote.open?.[index] ?? rawClose;
      const rawHigh = quote.high?.[index] ?? rawClose;
      const rawLow = quote.low?.[index] ?? rawClose;
      // 等比前复权：用 adjclose 替换 close，并按 adjclose/rawClose 比例同步缩放 O/H/L。
      // 这样 K 线形态保持一致（即「等比」），但价格基准被复权到当前。
      let open = rawOpen;
      let high = rawHigh;
      let low = rawLow;
      let close = rawClose;
      if (proportional) {
        const adj = adjcloseArr[index];
        if (Number.isFinite(adj) && rawClose !== 0) {
          const factor = adj / rawClose;
          close = adj;
          open = rawOpen * factor;
          high = rawHigh * factor;
          low = rawLow * factor;
        }
      }
      const volume = quote.volume?.[index] || 0;
      return [yahooDate(timestamp, gmtoffset), open, close, high, low, volume, 0, 0, 0, 0, 0]
        .map((value, fieldIndex) => (fieldIndex === 0 ? value : Number(value).toFixed(fieldIndex === 5 ? 0 : 3)))
        .join(",");
    })
    .filter(Boolean);

  if (klines.length === 0) throw new Error(`${code} 没有日线数据`);
  const name = await fetchSecurityName(code, market);
  let outMarket;
  if (market === "US") outMarket = "US";
  else if (market === "116") outMarket = 116;
  else if (market === "1") outMarket = 1;
  else if (market === "0") outMarket = 0;
  else outMarket = market;
  return {
    data: {
      code,
      name: name !== code ? name : result?.meta?.shortName || result?.meta?.longName || code,
      market: outMarket,
      klines,
      source: proportional ? "yahoo-proportional" : "yahoo",
    },
  };
}

async function fetchSinaKlines({ code, marketMode = "auto", beg, end }) {
  const symbol = toSinaSymbol(code, marketMode);
  const rows = await fetchJsonWithRetry(
    `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${symbol}&scale=240&ma=no&datalen=1000`,
    { headers: { Accept: "application/json,text/plain,*/*" } },
    `${code} sina kline`
  );
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${code} 没有日线数据`);

  const beginDate = formatSinaDate(beg);
  const endDate = formatSinaDate(end);
  const klines = rows
    .filter((row) => row.day >= beginDate && row.day <= endDate)
    .map((row) =>
      [
        row.day,
        row.open,
        row.close,
        row.high,
        row.low,
        row.volume,
        0,
        0,
        0,
        0,
        0,
      ].join(",")
    );

  if (klines.length === 0) throw new Error(`${code} 日期范围内没有日线数据`);
  const name = await fetchSecurityName(code, marketMode);
  return {
    data: {
      code,
      name,
      market: inferMarket(code) === "1" ? 1 : 0,
      klines,
      source: "sina",
    },
  };
}

// 腾讯日线（A 股）：支持真实前复权 / 后复权 / 不复权。
// 用作东方财富不可用时的复权数据源（Sina 只有不复权）。
async function fetchTencentKlines({ code, marketMode = "auto", adjust = "1", beg, end }) {
  const normalizedCode = normalizeSecurityCode(code);
  const market = marketMode === "auto" ? inferMarket(normalizedCode) : marketMode;
  const symbol = `${market === "1" ? "sh" : "sz"}${normalizedCode}`;
  const fq = adjust === "1" ? "qfq" : adjust === "2" ? "hfq" : "";
  const dayKey = fq ? `${fq}day` : "day";
  const begDate = formatSinaDate(beg);
  const endDate = formatSinaDate(end);
  const param = `${symbol},day,${begDate},${endDate},1000,${fq}`;
  const payload = await fetchJsonWithRetry(
    `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${param}`,
    { headers: { Accept: "application/json,text/plain,*/*" } },
    `${normalizedCode} tencent kline`
  );
  const symbolData = payload?.data?.[symbol] || {};
  const rows = symbolData[dayKey] || symbolData.day || symbolData.qfqday || symbolData.hfqday || [];
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${normalizedCode} 没有日线数据`);
  // 腾讯行格式：[日期, 开, 收, 高, 低, 量, ...]
  const klines = rows
    .filter((row) => Array.isArray(row) && row[0] >= begDate && row[0] <= endDate)
    .map((row) => [row[0], row[1], row[2], row[3], row[4], row[5], 0, 0, 0, 0, 0].join(","));
  if (klines.length === 0) throw new Error(`${normalizedCode} 日期范围内没有日线数据`);
  const name = await fetchSecurityName(normalizedCode, marketMode);
  return {
    data: {
      code: normalizedCode,
      name,
      market: market === "1" ? 1 : 0,
      klines,
      source: fq ? `tencent-${fq}` : "tencent",
    },
  };
}

// —— 实时行情（盘中用最新价，收盘用上一交易日收盘价）——
// 统一走腾讯 qt.gtimg.cn：A股/港股/美股字段排列一致，且在 Cloudflare 网络可达
// （东方财富在 Worker 出口 IP 常被拒，这也是历史上线后回退到腾讯日线、当天 bar 缺失的根因）。
function toTencentQuoteSymbol(code, market) {
  if (market === "US" || isUsSymbol(code)) return `us${code}`;
  if (market === "116") return `hk${code}`;
  return `${market === "1" ? "sh" : "sz"}${code}`;
}

// 腾讯报价时间字段格式随市场不同（20260603120549 / 2026/06/03 11:59:59 / 2026-06-02 16:00:01），
// 统一抽取前 8 位数字得到最近成交日 YYYYMMDD。
function tencentQuoteDate(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits.length >= 8 ? digits.slice(0, 8) : "";
}

async function fetchRealtimeQuote(code, market) {
  const normalizedCode = normalizeSecurityCode(code);
  const resolvedMarket = market === "auto" || !market ? inferMarket(normalizedCode) : market;
  const symbol = toTencentQuoteSymbol(normalizedCode, resolvedMarket);
  const response = await fetch(`https://qt.gtimg.cn/q=${symbol}`, {
    headers: { Referer: "https://gu.qq.com/", Accept: "*/*", "User-Agent": "Mozilla/5.0" },
  });
  if (!response.ok) throw new Error(`tencent quote ${symbol} returned ${response.status}`);
  // 返回体为 GBK，但我们只用数字字段（ASCII，任意解码都不变形；名称里不会出现分隔符 ~）。
  const text = await response.text();
  const match = text.match(/="([^"]*)"/);
  const fields = match ? match[1].split("~") : [];
  const price = Number(fields[3]);
  const date = tencentQuoteDate(fields[30]);
  if (!Number.isFinite(price) || price <= 0 || !/^\d{8}$/.test(date)) return null;
  const prevClose = Number(fields[4]);
  const open = Number(fields[5]);
  const high = Number(fields[33]);
  const low = Number(fields[34]);
  const volume = Number(fields[6]);
  return {
    price,
    prevClose: Number.isFinite(prevClose) && prevClose > 0 ? prevClose : null,
    open: Number.isFinite(open) && open > 0 ? open : price,
    high: Number.isFinite(high) && high > 0 ? high : null,
    low: Number.isFinite(low) && low > 0 ? low : null,
    volume: Number.isFinite(volume) ? volume : 0,
    date,
    time: fields[30] || "",
  };
}

// 把实时报价合并进日线序列：
//   · 盘中 → 最近成交日(=今天)出现一根带最新价的 bar；
//   · 已收盘 → 报价日期回落到上一交易日，与历史末根一致，相当于“按前一日收盘价”。
// 实时价是不复权原始价，历史可能是前/后复权/等比，故用“实时 bar 前一交易日”的
// 复权收盘 ÷ 该日不复权收盘(=报价 prevClose) 求缩放因子，保证拼接处不跳变。
function applyRealtimeQuote(data, quote, requestedEnd) {
  if (!quote || !data || !Array.isArray(data.klines) || data.klines.length === 0) return;
  const klines = data.klines;
  const lastParts = klines[klines.length - 1].split(",");
  const lastDateCompact = String(lastParts[0]).replace(/-/g, "");
  const quoteDate = quote.date;

  // 用户查询区间未覆盖到报价日（在看历史段）→ 保持纯历史，不叠加实时。
  if (requestedEnd && /^\d{8}$/.test(requestedEnd) && quoteDate > requestedEnd) return;
  // 报价日早于历史末根（异常）→ 不动。
  if (quoteDate < lastDateCompact) return;

  const isSameDay = quoteDate === lastDateCompact;
  const prevAdjClose = isSameDay
    ? (klines.length >= 2 ? Number(klines[klines.length - 2].split(",")[2]) : NaN)
    : Number(lastParts[2]);
  let factor = 1;
  if (quote.prevClose && Number.isFinite(prevAdjClose) && prevAdjClose > 0) {
    const ratio = prevAdjClose / quote.prevClose;
    if (Number.isFinite(ratio) && ratio > 0.2 && ratio < 5) factor = ratio;
  }

  const close = quote.price * factor;
  const openSrc = quote.open ?? quote.price;
  const highSrc = quote.high ?? Math.max(openSrc, quote.price);
  const lowSrc = quote.low ?? Math.min(openSrc, quote.price);
  const open = openSrc * factor;
  const high = highSrc * factor;
  const low = lowSrc * factor;
  const basePrev = quote.prevClose ? quote.prevClose * factor : prevAdjClose;
  const changeAmount = Number.isFinite(basePrev) ? close - basePrev : 0;
  const changePct = Number.isFinite(basePrev) && basePrev ? (changeAmount / basePrev) * 100 : 0;
  const amplitude = Number.isFinite(basePrev) && basePrev ? ((high - low) / basePrev) * 100 : 0;
  const isoDate = `${quoteDate.slice(0, 4)}-${quoteDate.slice(4, 6)}-${quoteDate.slice(6, 8)}`;

  const row = [
    isoDate,
    open.toFixed(3),
    close.toFixed(3),
    high.toFixed(3),
    low.toFixed(3),
    Math.round(quote.volume || 0),
    0,
    amplitude.toFixed(2),
    changePct.toFixed(2),
    changeAmount.toFixed(3),
    "0.00",
  ].join(",");

  if (isSameDay) klines[klines.length - 1] = row;
  else klines.push(row);

  data.realtime = {
    price: Number(close.toFixed(3)),
    prevClose: quote.prevClose ? Number((quote.prevClose * factor).toFixed(3)) : null,
    date: isoDate,
    time: quote.time,
    appended: !isSameDay,
  };
}

// 取到历史日线后，尽力叠加一根实时 bar；实时源失败则保留历史日线（优雅降级）。
async function finalizeKlines(payload, code, market, requestedEnd) {
  try {
    const quote = await fetchRealtimeQuote(code, market).catch(() => null);
    if (quote) applyRealtimeQuote(payload.data, quote, requestedEnd);
  } catch {
    // 实时叠加是尽力而为，失败不影响历史日线返回。
  }
  return json(payload);
}

async function handleKlines(request) {
  const url = new URL(request.url);
  const code = normalizeSecurityCode(url.searchParams.get("code"));
  const marketMode = String(url.searchParams.get("marketMode") || "auto");
  const adjust = String(url.searchParams.get("adjust") || "1");
  const beg = String(url.searchParams.get("beg") || "20200101");
  const end = String(url.searchParams.get("end") || currentShanghaiParts().date.replaceAll("-", ""));

  if (!code) return json({ error: "\u8bf7\u8f93\u5165 A \u80a1/ETF 6 \u4f4d\u4ee3\u7801\u3001\u6e2f\u80a1 1-5 \u4f4d\u4ee3\u7801\u6216\u7f8e\u80a1\u82f1\u6587\u4ee3\u7801\u3002" }, 400);
  if (!/^\d{8}$/.test(beg) || !/^\d{8}$/.test(end)) return json({ error: "日期格式无效。" }, 400);
  if (!["auto", "0", "1", "116", "US"].includes(marketMode)) return json({ error: "市场参数无效。" }, 400);
  if (!["0", "1", "2", "3"].includes(adjust)) return json({ error: "复权参数无效。" }, 400);

  const market = marketMode === "auto" ? inferMarket(code) : marketMode;
  if (market === "US" && !isUsSymbol(code)) return json({ error: "\u7f8e\u80a1\u8bf7\u8f93\u5165 AAPL \u8fd9\u6837\u7684\u82f1\u6587\u4ee3\u7801\u3002" }, 400);
  // adjust=3 等比前复权：所有市场都走 Yahoo（A 股用 .SS/.SZ 后缀），用 adjclose 做等比缩放。
  if (adjust === "3") {
    const payload = await fetchYahooKlines({ code, marketMode: market, beg, end, proportional: true });
    payload.data.adjust = "3";
    payload.data.requestedAdjust = "3";
    return await finalizeKlines(payload, code, market, end);
  }

  if (market === "116" || market === "US") {
    return await finalizeKlines(await fetchYahooKlines({ code, marketMode: market, beg, end }), code, market, end);
  }

  try {
    return await finalizeKlines(await fetchEastmoneyKlines({ code, marketMode, adjust, beg, end }), code, market, end);
  } catch (eastmoneyError) {
    // 东方财富不可用时，优先用腾讯复权源（真实前/后复权），仍失败再退到 Sina 不复权。
    try {
      return await finalizeKlines(await fetchTencentKlines({ code, marketMode, adjust, beg, end }), code, market, end);
    } catch (tencentError) {
      try {
        const fallback = await fetchSinaKlines({ code, marketMode, beg, end });
        fallback.data.adjust = "0";
        fallback.data.requestedAdjust = adjust;
        fallback.data.adjustFallback = adjust !== "0";
        fallback.data.adjustFallbackReason = `${eastmoneyError.message || "Eastmoney fetch failed"}; tencent: ${tencentError.message || "failed"}`;
        return await finalizeKlines(fallback, code, market, end);
      } catch {
        throw eastmoneyError;
      }
    }
  }
}

function renderEmail(subscription, snapshots) {
  const rows = snapshots
    .map(
      (item) => `
        <tr>
          <td>${item.name} ${item.code}</td>
          <td>${item.date}</td>
          <td>${formatNumber(item.close)}</td>
          <td>${formatNumber(item.middle)}</td>
          <td>${formatNumber(item.standardDeviation)}</td>
          <td>${formatNumber(item.bands[1].upper)} / ${formatNumber(item.bands[1].lower)}</td>
          <td>${formatNumber(item.bands[2].upper)} / ${formatNumber(item.bands[2].lower)}</td>
          <td>${formatNumber(item.bands[3].upper)} / ${formatNumber(item.bands[3].lower)}</td>
        </tr>
      `
    )
    .join("");

  return `
    <div style="font-family:Arial,'Microsoft YaHei',sans-serif;color:#172033;">
      <h2>日布林带推送</h2>
      <p>周期 N=${subscription.period || DEFAULT_PERIOD}，轨道为中线 ± 1/2/3 × 标准差，按所选市场日线计算。</p>
      <table cellpadding="8" cellspacing="0" border="1" style="border-collapse:collapse;font-size:13px;">
        <thead>
          <tr>
            <th>股票</th><th>日期</th><th>收盘</th><th>中线</th><th>标准差</th><th>K=1 上/下</th><th>K=2 上/下</th><th>K=3 上/下</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="color:#64748b;font-size:12px;">本邮件按你的页面订阅设置发送。</p>
    </div>
  `;
}

async function sendResendEmail(env, to, subject, html) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) {
    throw new Error("Missing RESEND_API_KEY or RESEND_FROM_EMAIL");
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to,
      subject,
      html,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || "Resend send failed");
  return payload;
}

function renderLoginCodeEmail(code) {
  return `
    <div style="font-family:Arial,'Microsoft YaHei',sans-serif;color:#172033;">
      <h2>日布林带登录验证码</h2>
      <p>你的验证码是：</p>
      <p style="font-size:28px;font-weight:800;letter-spacing:6px;margin:16px 0;">${code}</p>
      <p style="color:#64748b;font-size:13px;">验证码 10 分钟内有效。登录后只能查看和管理当前邮箱自己的私有列表与订阅记录。</p>
    </div>
  `;
}

async function readWatchlist(env, email) {
  const raw = await env.SUBSCRIPTIONS.get(`watchlist:${email}`);
  const record = safeJsonParse(raw, {});
  const codes = sanitizeStockCodes(record?.codes || record);
  const finalCodes = codes.length > 0 ? codes : DEFAULT_WATCHLIST_CODES;
  return {
    codes: finalCodes,
    stocks: await publicStocks(finalCodes),
    updatedAt: record?.updatedAt || null,
  };
}

async function getUserState(env, email) {
  const [watchlist, dailyRaw, alertRaw] = await Promise.all([
    readWatchlist(env, email),
    env.SUBSCRIPTIONS.get(`sub:${email}`),
    env.SUBSCRIPTIONS.get(`alert:${email}`),
  ]);
  const [daily, alert] = await Promise.all([
    dailyRaw ? publicSubscription(safeJsonParse(dailyRaw)) : null,
    alertRaw ? publicAlertSubscription(safeJsonParse(alertRaw)) : null,
  ]);
  return {
    email,
    watchlist,
    daily,
    alert,
    hasAny: Boolean(daily || alert),
    checkedAt: new Date().toISOString(),
  };
}

async function handleRequestLoginCode(request, env) {
  const body = await request.json().catch(() => null);
  const email = String(body?.email || "").trim().toLowerCase();
  if (!isEmail(email)) return json({ error: "请输入有效邮箱。" }, 400);

  const code = makeRandomDigits();
  await env.SUBSCRIPTIONS.put(
    `login:${email}`,
    JSON.stringify({
      email,
      code,
      attempts: 0,
      expiresAt: new Date(Date.now() + LOGIN_CODE_TTL_SECONDS * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    }),
    { expirationTtl: LOGIN_CODE_TTL_SECONDS }
  );

  await sendResendEmail(env, email, "日布林带登录验证码", renderLoginCodeEmail(code));
  return json({ ok: true, email, expiresIn: LOGIN_CODE_TTL_SECONDS });
}

async function handleVerifyLogin(request, env) {
  const body = await request.json().catch(() => null);
  const email = String(body?.email || "").trim().toLowerCase();
  const code = String(body?.code || "").trim();
  if (!isEmail(email)) return json({ error: "请输入有效邮箱。" }, 400);
  if (!/^\d{6}$/.test(code)) return json({ error: "请输入 6 位验证码。" }, 400);

  const key = `login:${email}`;
  const record = safeJsonParse(await env.SUBSCRIPTIONS.get(key));
  if (!record?.code || !record?.expiresAt) return json({ error: "验证码已失效，请重新获取。" }, 400);
  if (new Date(record.expiresAt).getTime() <= Date.now()) {
    await env.SUBSCRIPTIONS.delete(key);
    return json({ error: "验证码已过期，请重新获取。" }, 400);
  }
  if (record.code !== code) {
    const attempts = Number(record.attempts || 0) + 1;
    if (attempts >= 5) {
      await env.SUBSCRIPTIONS.delete(key);
      return json({ error: "验证码错误次数过多，请重新获取。" }, 400);
    }
    const ttl = Math.max(60, Math.floor((new Date(record.expiresAt).getTime() - Date.now()) / 1000));
    await env.SUBSCRIPTIONS.put(key, JSON.stringify({ ...record, attempts }), { expirationTtl: ttl });
    return json({ error: "验证码不正确。" }, 400);
  }

  const token = makeSessionToken();
  const session = {
    email,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString(),
  };
  await Promise.all([
    env.SUBSCRIPTIONS.put(`session:${token}`, JSON.stringify(session), { expirationTtl: SESSION_TTL_SECONDS }),
    env.SUBSCRIPTIONS.delete(key),
  ]);

  const state = await getUserState(env, email);
  return json({ ok: true, token, user: { email }, ...state });
}

async function handleMe(request, env) {
  const user = await requireUser(request, env);
  if (user.response) return user.response;
  return json({ ok: true, user: { email: user.email }, ...(await getUserState(env, user.email)) });
}

async function handleLogout(request, env) {
  const token = getBearerToken(request);
  if (token) await env.SUBSCRIPTIONS.delete(`session:${token}`);
  return json({ ok: true });
}

async function handleWatchlist(request, env) {
  const user = await requireUser(request, env);
  if (user.response) return user.response;

  if (request.method === "GET") {
    return json({ ok: true, email: user.email, watchlist: await readWatchlist(env, user.email) });
  }

  const body = await request.json().catch(() => null);
  const codes = sanitizeStockCodes(body?.codes || body?.stocks);
  if (codes.length === 0) return json({ error: "请至少保存一只股票。" }, 400);

  const record = {
    email: user.email,
    codes,
    updatedAt: new Date().toISOString(),
  };
  await env.SUBSCRIPTIONS.put(`watchlist:${user.email}`, JSON.stringify(record));
  return json({ ok: true, email: user.email, watchlist: await readWatchlist(env, user.email) });
}

async function sendEmail(env, subscription, snapshots, subjectPrefix = "日布林带推送") {
  return sendResendEmail(env, subscription.email, `${subjectPrefix} ${currentShanghaiParts().date}`, renderEmail(subscription, snapshots));
}

function evaluateAlert(snapshot, subscription) {
  const multiplier = Number(subscription.multiplier || 2);
  const condition = subscription.condition || "outside";
  const band = snapshot.bands[multiplier];
  if (!band) return null;

  const above = snapshot.close > band.upper;
  const below = snapshot.close < band.lower;
  const matched = condition === "above" ? above : condition === "below" ? below : above || below;
  if (!matched) return null;

  const side = above ? "高于上轨" : "低于下轨";
  const boundary = above ? band.upper : band.lower;
  const sigmaOffset = snapshot.standardDeviation ? (snapshot.close - snapshot.middle) / snapshot.standardDeviation : 0;
  return {
    ...snapshot,
    multiplier,
    condition,
    side,
    boundary,
    distance: snapshot.close - boundary,
    sigmaOffset,
    alertKey: `${snapshot.date}:${snapshot.code}:${condition}:${multiplier}:${side}`,
  };
}

function renderAlertEmail(subscription, alerts) {
  const rows = alerts
    .map(
      (item) => `
        <tr>
          <td>${item.name} ${item.code}</td>
          <td>${item.date}</td>
          <td>${item.side}</td>
          <td>${formatNumber(item.close)}</td>
          <td>${formatNumber(item.boundary)}</td>
          <td>${formatNumber(item.middle)}</td>
          <td>${formatNumber(item.standardDeviation)}</td>
          <td>${formatSigma(item.sigmaOffset)}</td>
          <td>${formatNumber(item.distance)}</td>
        </tr>
      `
    )
    .join("");

  return `
    <div style="font-family:Arial,'Microsoft YaHei',sans-serif;color:#172033;">
      <h2>日布林带预警</h2>
      <p>触发条件：${ALERT_CONDITIONS[subscription.condition] || ALERT_CONDITIONS.outside}，轨道：中线 ± ${subscription.multiplier || 2} × 标准差，周期 N=${subscription.period || DEFAULT_PERIOD}。</p>
      <table cellpadding="8" cellspacing="0" border="1" style="border-collapse:collapse;font-size:13px;">
        <thead>
          <tr>
            <th>股票</th><th>日期</th><th>触发</th><th>收盘</th><th>边界</th><th>中线</th><th>标准差</th><th>当前偏离</th><th>边界差值</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="color:#64748b;font-size:12px;">同一邮箱、同一股票、同一规则在同一交易日只发送一次预警。</p>
    </div>
  `;
}

function renderAlertConfirmationEmail(subscription, snapshots) {
  const rows = snapshots
    .map((item) => {
      const alert = evaluateAlert(item, subscription);
      const band = item.bands[subscription.multiplier];
      const sigmaOffset = item.standardDeviation ? (item.close - item.middle) / item.standardDeviation : 0;
      return `
        <tr>
          <td>${item.name} ${item.code}</td>
          <td>${item.date}</td>
          <td>${formatNumber(item.close)}</td>
          <td>${formatNumber(band.upper)} / ${formatNumber(band.lower)}</td>
          <td>${formatSigma(sigmaOffset)}</td>
          <td>${alert ? alert.side : "未触发"}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <div style="font-family:Arial,'Microsoft YaHei',sans-serif;color:#172033;">
      <h2>日布林带预警订阅已开启</h2>
      <p>触发条件：${ALERT_CONDITIONS[subscription.condition] || ALERT_CONDITIONS.outside}，轨道：中线 ± ${subscription.multiplier} × 标准差，周期 N=${subscription.period}。</p>
      <table cellpadding="8" cellspacing="0" border="1" style="border-collapse:collapse;font-size:13px;">
        <thead>
          <tr><th>股票</th><th>日期</th><th>收盘</th><th>预警边界</th><th>当前偏离</th><th>当前状态</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="color:#64748b;font-size:12px;">服务器会自动检查并在触发时发送预警邮件，不需要网页保持打开。</p>
    </div>
  `;
}

async function sendAlertEmail(env, subscription, alerts, subjectPrefix = "日布林带预警") {
  return sendResendEmail(env, subscription.email, `${subjectPrefix} ${currentShanghaiParts().date}`, renderAlertEmail(subscription, alerts));
}

async function handleSubscribe(request, env) {
  const body = await request.json().catch(() => null);
  const user = getBearerToken(request) ? await requireUser(request, env) : null;
  if (user?.response) return user.response;

  const email = user?.email || String(body?.email || "").trim().toLowerCase();
  const sendTime = String(body?.sendTime || "");
  const stocks = sanitizeStockCodes(body?.stocks);
  const period = normalizePeriod(body?.period, DEFAULT_PERIOD);

  if (!isEmail(email)) return json({ error: "请输入有效邮箱。" }, 400);
  if (!/^\d{2}:\d{2}$/.test(sendTime)) return json({ error: "请选择每天推送时间。" }, 400);
  if (stocks.length === 0) return json({ error: "请至少选择一只股票。" }, 400);
  if (!period) return json({ error: "周期 N 需要是 2 到 250 之间的整数。" }, 400);

  // 重新提交订阅时保留 lastSentDate，避免“当天已推送过 + 立刻又在 sendTime 重复推送”。
  const previous = safeJsonParse(await env.SUBSCRIPTIONS.get(`sub:${email}`));
  const subscription = {
    email,
    sendTime,
    stocks,
    period,
    multipliers: MULTIPLIERS,
    timezone: TIMEZONE,
    updatedAt: new Date().toISOString(),
    lastSentDate: previous?.lastSentDate || null,
  };
  await env.SUBSCRIPTIONS.put(`sub:${email}`, JSON.stringify(subscription));

  const snapshots = await mapWithConcurrency(stocks, 4, (code) => fetchStockSnapshot(code, period));
  await sendEmail(env, subscription, snapshots, "订阅成功：日布林带推送已开启");

  return json({ ok: true, subscription, sentInitialEmail: true });
}

async function handleAlertSubscribe(request, env) {
  const body = await request.json().catch(() => null);
  const user = getBearerToken(request) ? await requireUser(request, env) : null;
  if (user?.response) return user.response;

  const email = user?.email || String(body?.email || "").trim().toLowerCase();
  const stocks = sanitizeStockCodes(body?.stocks);
  const period = normalizePeriod(body?.period, DEFAULT_PERIOD);
  const multiplier = Number(body?.multiplier || 2);
  const condition = String(body?.condition || "outside");

  if (!isEmail(email)) return json({ error: "请输入有效邮箱。" }, 400);
  if (stocks.length === 0) return json({ error: "请至少选择一只股票。" }, 400);
  if (!period) return json({ error: "周期 N 需要是 2 到 250 之间的整数。" }, 400);
  if (!MULTIPLIERS.includes(multiplier)) return json({ error: "预警轨道只能选择 1、2 或 3 倍标准差。" }, 400);
  if (!Object.prototype.hasOwnProperty.call(ALERT_CONDITIONS, condition)) return json({ error: "预警条件无效。" }, 400);

  // 重新提交订阅时继承已发送的 alertKey（key 内含日期/规则，旧规则的 key 不影响新规则），
  // 否则重新保存订阅会重置去重集合，同一交易日会重复发送已发过的预警。
  const previous = safeJsonParse(await env.SUBSCRIPTIONS.get(`alert:${email}`));
  const subscription = {
    email,
    stocks,
    period,
    multiplier,
    condition,
    timezone: TIMEZONE,
    updatedAt: new Date().toISOString(),
    lastAlertKeys: Array.isArray(previous?.lastAlertKeys) ? previous.lastAlertKeys : [],
    lastAlertAt: previous?.lastAlertAt || null,
  };
  await env.SUBSCRIPTIONS.put(`alert:${email}`, JSON.stringify(subscription));

  const snapshots = await mapWithConcurrency(stocks, 4, (code) => fetchStockSnapshot(code, period));
  await sendResendEmail(
    env,
    subscription.email,
    `预警订阅成功：日布林带 ${currentShanghaiParts().date}`,
    renderAlertConfirmationEmail(subscription, snapshots)
  );

  return json({ ok: true, subscription, sentInitialEmail: true });
}

async function publicSubscription(subscription) {
  if (!subscription) return null;
  return {
    email: subscription.email,
    sendTime: subscription.sendTime,
    stocks: await publicStocks(subscription.stocks || []),
    period: subscription.period || DEFAULT_PERIOD,
    timezone: subscription.timezone || TIMEZONE,
    updatedAt: subscription.updatedAt || null,
    lastSentDate: subscription.lastSentDate || null,
  };
}

async function publicAlertSubscription(subscription) {
  if (!subscription) return null;
  return {
    email: subscription.email,
    stocks: await publicStocks(subscription.stocks || []),
    period: subscription.period || DEFAULT_PERIOD,
    multiplier: subscription.multiplier || 2,
    condition: subscription.condition || "outside",
    conditionLabel: ALERT_CONDITIONS[subscription.condition] || ALERT_CONDITIONS.outside,
    timezone: subscription.timezone || TIMEZONE,
    updatedAt: subscription.updatedAt || null,
    lastAlertAt: subscription.lastAlertAt || null,
    sentAlertCount: Array.isArray(subscription.lastAlertKeys) ? subscription.lastAlertKeys.length : 0,
  };
}

async function handleSubscriptions(request, env) {
  const user = await requireUser(request, env);
  if (user.response) return user.response;
  return json(await getUserState(env, user.email));
}

async function handleUnsubscribe(request, env) {
  const user = await requireUser(request, env);
  if (user.response) return user.response;

  const body = await request.json().catch(() => null);
  const email = user.email;
  const type = String(body?.type || "");

  if (!["daily", "alert", "all"].includes(type)) return json({ error: "取消类型无效。" }, 400);

  const targets = [];
  if (type === "daily" || type === "all") targets.push({ type: "daily", key: `sub:${email}` });
  if (type === "alert" || type === "all") targets.push({ type: "alert", key: `alert:${email}` });

  const before = await Promise.all(targets.map((target) => env.SUBSCRIPTIONS.get(target.key)));
  await Promise.all(targets.map((target) => env.SUBSCRIPTIONS.delete(target.key)));

  const state = await getUserState(env, email);

  return json({
    ok: true,
    email,
    removed: targets.map((target, index) => ({ type: target.type, existed: Boolean(before[index]) })),
    ...state,
  });
}

async function sendDueSubscriptions(env, force = false) {
  const now = currentShanghaiParts();
  const list = await env.SUBSCRIPTIONS.list({ prefix: "sub:" });
  const results = [];

  for (const key of list.keys) {
    // 单个订阅（或其中一只股票）失败不应中断整个批次，否则后面的订阅者全部收不到邮件。
    try {
      const subscription = safeJsonParse(await env.SUBSCRIPTIONS.get(key.name));
      if (!subscription?.email || !Array.isArray(subscription.stocks)) continue;
      if (!force && subscription.sendTime !== now.time) continue;
      if (!force && subscription.lastSentDate === now.date) continue;

      const snapshots = (
        await mapWithConcurrency(subscription.stocks, 4, (code) =>
          fetchStockSnapshot(code, subscription.period).catch((err) => {
            console.warn(`[daily] snapshot failed ${code}:`, err?.message || err);
            return null;
          })
        )
      ).filter(Boolean);
      if (snapshots.length === 0) {
        results.push({ email: subscription.email, count: 0, error: "所有股票行情拉取失败，本次跳过" });
        continue;
      }
      await sendEmail(env, subscription, snapshots);
      subscription.lastSentDate = now.date;
      await env.SUBSCRIPTIONS.put(key.name, JSON.stringify(subscription));
      results.push({ email: subscription.email, count: snapshots.length });
    } catch (err) {
      console.error(`[daily] ${key.name} failed:`, err?.message || err);
      results.push({ key: key.name, error: err?.message || String(err) });
    }
  }

  return results;
}

async function sendDueAlerts(env, force = false) {
  const list = await env.SUBSCRIPTIONS.list({ prefix: "alert:" });
  const results = [];

  for (const key of list.keys) {
    // 单个订阅（或其中一只股票）失败不应中断整个批次。
    try {
      const subscription = safeJsonParse(await env.SUBSCRIPTIONS.get(key.name));
      if (!subscription?.email || !Array.isArray(subscription.stocks)) continue;
      const snapshots = (
        await mapWithConcurrency(subscription.stocks, 4, (code) =>
          fetchStockSnapshot(code, subscription.period).catch((err) => {
            console.warn(`[alert] snapshot failed ${code}:`, err?.message || err);
            return null;
          })
        )
      ).filter(Boolean);
      const sentKeys = new Set(subscription.lastAlertKeys || []);
      const alerts = snapshots.map((snapshot) => evaluateAlert(snapshot, subscription)).filter(Boolean);
      const newAlerts = force ? alerts : alerts.filter((alert) => !sentKeys.has(alert.alertKey));
      if (newAlerts.length === 0) {
        results.push({ email: subscription.email, checked: snapshots.length, sent: 0 });
        continue;
      }

      await sendAlertEmail(env, subscription, newAlerts);
      const nextKeys = [...sentKeys, ...newAlerts.map((alert) => alert.alertKey)].slice(-300);
      subscription.lastAlertKeys = nextKeys;
      subscription.lastAlertAt = new Date().toISOString();
      await env.SUBSCRIPTIONS.put(key.name, JSON.stringify(subscription));
      results.push({ email: subscription.email, checked: snapshots.length, sent: newAlerts.length });
    } catch (err) {
      console.error(`[alert] ${key.name} failed:`, err?.message || err);
      results.push({ key: key.name, error: err?.message || String(err) });
    }
  }

  return results;
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") return json({});
      if (url.pathname === "/api/health") return json({ ok: true });
      if (url.pathname === "/api/klines" && request.method === "GET") return await klineCache(request, () => handleKlines(request));
      if (url.pathname === "/api/auth/request-code" && request.method === "POST") return await handleRequestLoginCode(request, env);
      if (url.pathname === "/api/auth/verify" && request.method === "POST") return await handleVerifyLogin(request, env);
      if (url.pathname === "/api/me" && request.method === "GET") return await handleMe(request, env);
      if (url.pathname === "/api/logout" && request.method === "POST") return await handleLogout(request, env);
      if (url.pathname === "/api/watchlist" && request.method === "GET") return await handleWatchlist(request, env);
      if (url.pathname === "/api/watchlist" && request.method === "PUT") return await handleWatchlist(request, env);
      if (url.pathname === "/api/subscriptions" && request.method === "GET") return await handleSubscriptions(request, env);
      if (url.pathname === "/api/unsubscribe" && request.method === "POST") return await handleUnsubscribe(request, env);
      if (url.pathname === "/api/subscribe" && request.method === "POST") return await handleSubscribe(request, env);
      if (url.pathname === "/api/subscribe-alert" && request.method === "POST") return await handleAlertSubscribe(request, env);
      if (url.pathname === "/api/send-daily" && request.method === "POST") {
        if (!env.ALERT_SECRET || request.headers.get("Authorization") !== `Bearer ${env.ALERT_SECRET}`) {
          return json({ error: "Unauthorized" }, 401);
        }
        return json({ sent: await sendDueSubscriptions(env, true) });
      }
      if (url.pathname === "/api/send-alerts" && request.method === "POST") {
        if (!env.ALERT_SECRET || request.headers.get("Authorization") !== `Bearer ${env.ALERT_SECRET}`) {
          return json({ error: "Unauthorized" }, 401);
        }
        return json({ sent: await sendDueAlerts(env, true) });
      }
      if (url.pathname === "/api/pcb-bollinger" && request.method === "GET") {
        return await handlePcbBollinger(request, env);
      }
      if (url.pathname === "/api/sector-bollinger" && request.method === "GET") {
        return await handleSectorBollinger(request, env);
      }
      if (url.pathname === "/api/sector-list" && request.method === "GET") {
        return await handleSectorList(env);
      }
      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message || "Worker error" }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    const tasks = [sendDueSubscriptions(env), sendDueAlerts(env)];
    if (shouldRefreshPcbNow()) {
      // 先刷板块清单（供 getBoardName 命名），再刷“被访问过的板块集合”（始终含 PCB）
      tasks.push(
        (async () => {
          await refreshSectorList(env).catch((err) => console.error("[sector list refresh]", err?.message || err));
          const bks = await getTrackedSectors(env);
          await mapWithConcurrency(bks, 2, (bk) =>
            refreshSectorBollinger(env, bk).catch((err) =>
              console.error(`[sector refresh ${bk}]`, err?.message || err)
            )
          );
        })().catch((err) => console.error("[sector refresh]", err?.message || err))
      );
    }
    ctx.waitUntil(Promise.all(tasks));
  },
};

// ============================================================================
// 板块布林带看板（PCB 的泛化版：任意东财板块 BKxxxx → TopN 流通市值 → 20日布林带）
// ============================================================================
// 数据源：
//   1) 成分名单 = 东方财富板块 clist（fs=b:BKxxxx，按流通市值 f21 降序取 TopN）
//   2) 历史K线 = 腾讯前复权日线（与 fetchSectorCloses 同一接口）
//   3) 板块清单 = 东方财富 概念(t:3)+行业(t:2) 板块全集，供前端搜索/自选
// 每工作日 16:00（北京时间）自动刷新“被访问过的板块集合”与板块清单到 KV。
// 前端读 /api/sector-bollinger?bk=BKxxxx（PCB 走缺省 bk=BK0877）或 /api/sector-list。

const PCB_BK_CODE = "BK0877"; // 东财 PCB 概念板块（默认自选之一，含硬编码兜底）
const SECTOR_TOP_N = 20;
const SECTOR_LOOKBACK_DAYS = 20;
const SECTOR_LIST_KV_KEY = "sector:list:v1";
const SECTOR_TRACKED_KV_KEY = "sector:tracked";
const SECTOR_TRACKED_MAX = 40;
const SECTOR_BK_RE = /^BK\d{4,6}$/;
const EASTMONEY_HOSTS = [
  "push2.eastmoney.com",
  "50.push2.eastmoney.com",
  "19.push2.eastmoney.com",
  "44.push2.eastmoney.com",
  "82.push2.eastmoney.com",
];
const SECTOR_DEFAULT_ADJUST = "qfq";
const SECTOR_ADJUSTS = new Set(["qfq", "hfq", "none"]);
// 默认参数保持旧 key，兼容既有 KV 缓存和 16:00 定时刷新；自定义参数用带参 key。
const sectorBollingerKey = (bk, days = SECTOR_LOOKBACK_DAYS, adjust = SECTOR_DEFAULT_ADJUST) =>
  days === SECTOR_LOOKBACK_DAYS && adjust === SECTOR_DEFAULT_ADJUST
    ? `sector:bollinger:${bk}`
    : `sector:bollinger:${bk}:${days}:${adjust}`;
const sectorRankingKey = (bk) => `sector:ranking:${bk}`;

function beijingDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now); // YYYY-MM-DD
}

// 硬编码种子：东方财富在 Worker 出口 IP 常被拒（注释见 fetchTencentKlines 上方）。
// 排名变动较慢，拉不到时直接用这个，依然能跑出每日布林带。
// 更新时间：2026-06-21（按当时财联社/东财 PCB 板块流通市值降序）。
const PCB_TOP20_SEED = [
  { code: "600183", name: "生益科技", market: "1", mcap: 4.40277e11 },
  { code: "002384", name: "东山精密", market: "0", mcap: 3.78466e11 },
  { code: "300476", name: "胜宏科技", market: "0", mcap: 3.19257e11 },
  { code: "002916", name: "深南电路", market: "0", mcap: 3.01691e11 },
  { code: "002463", name: "沪电股份", market: "0", mcap: 2.84384e11 },
  { code: "002938", name: "鹏鼎控股", market: "0", mcap: 2.76918e11 },
  { code: "603256", name: "宏和科技", market: "1", mcap: 2.26794e11 },
  { code: "600176", name: "中国巨石", market: "1", mcap: 2.14168e11 },
  { code: "600522", name: "中天科技", market: "1", mcap: 1.93002e11 },
  { code: "301217", name: "铜冠铜箔", market: "0", mcap: 1.65803e11 },
  { code: "301200", name: "大族数控", market: "0", mcap: 1.43305e11 },
  { code: "000657", name: "中钨高新", market: "0", mcap: 1.43084e11 },
  { code: "002080", name: "中材科技", market: "0", mcap: 1.35173e11 },
  { code: "002008", name: "大族激光", market: "0", mcap: 1.29063e11 },
  { code: "688183", name: "生益电子", market: "1", mcap: 1.16006e11 },
  { code: "688519", name: "南亚新材", market: "1", mcap: 9.3367e10 },
  { code: "603228", name: "景旺电子", market: "1", mcap: 7.9098e10 },
  { code: "002436", name: "兴森科技", market: "0", mcap: 7.9023e10 },
  { code: "002636", name: "金安国纪", market: "0", mcap: 7.5626e10 },
  { code: "601208", name: "东材科技", market: "1", mcap: 7.5592e10 },
];

function shouldRefreshPcbNow(now = new Date()) {
  // cron 每分钟跑一次，这里只放行 北京时间 工作日 16:00（含 16:00~16:02 容错窗口）
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const isWeekday = !["Sat", "Sun"].includes(parts.weekday);
  const hour = parseInt(parts.hour, 10);
  const minute = parseInt(parts.minute, 10);
  return isWeekday && hour === 16 && minute < 3;
}

async function fetchSectorRanking(env, bk, topN = SECTOR_TOP_N) {
  // 东财 push2 有多个分片，Worker 出口 IP 在某些分片上会 502。逐个试，命中即返回；
  // 全失败则回退 KV 上次缓存，仅 PCB(BK0877) 再回退硬编码种子，其余抛错交前端提示。
  const urls = EASTMONEY_HOSTS.map(
    (h) =>
      `https://${h}/api/qt/clist/get` +
      `?pn=1&pz=${topN + 5}&po=1&np=1&fid=f21&fs=b:${bk}` +
      `&fields=f12,f13,f14,f21`
  );
  try {
    const data = await fetchJsonWithRetry(
      urls,
      { headers: { Accept: "application/json", Referer: "https://quote.eastmoney.com/" } },
      `eastmoney plate ${bk}`
    );
    const diff = data?.data?.diff;
    if (!diff) throw new Error(`eastmoney 未返回板块 ${bk} 成分股`);
    const list = Array.isArray(diff) ? diff : Object.values(diff);
    const ranking = list.slice(0, topN).map((item) => ({
      code: String(item.f12),
      name: String(item.f14),
      market: item.f13 === 1 ? "1" : "0",
      mcap: Number(item.f21) || 0,
    }));
    if (ranking.length) {
      // 成功，写回 KV 作为后续兜底
      await env.SUBSCRIPTIONS.put(
        sectorRankingKey(bk),
        JSON.stringify({ savedAt: new Date().toISOString(), ranking })
      ).catch(() => {});
      return { ranking, source: "eastmoney" };
    }
  } catch (err) {
    console.warn(`[sector] eastmoney ranking failed for ${bk}:`, err?.message || err);
  }
  // 回退 1：KV 上次成功的排名
  const cached = safeJsonParse(await env.SUBSCRIPTIONS.get(sectorRankingKey(bk)));
  if (cached?.ranking?.length) {
    return { ranking: cached.ranking, source: `kv-cache (saved ${cached.savedAt})` };
  }
  // 回退 2：仅 PCB 有硬编码种子
  if (bk === PCB_BK_CODE) {
    return { ranking: PCB_TOP20_SEED, source: "hardcoded-seed" };
  }
  throw new Error(`暂时无法获取板块 ${bk} 成分股，请稍后重试`);
}

async function fetchSectorCloses(stock, days = SECTOR_LOOKBACK_DAYS, adjust = SECTOR_DEFAULT_ADJUST) {
  const symbol = `${stock.market === "1" ? "sh" : "sz"}${stock.code}`;
  const fq = adjust === "none" ? "" : adjust;
  const param = `${symbol},day,,,${days + 10},${fq}`;
  const payload = await fetchJsonWithRetry(
    `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${param}`,
    { headers: { Accept: "application/json,text/plain,*/*" } },
    `${stock.code} sector kline`
  );
  const obj = payload?.data?.[symbol] || {};
  const rows = (fq && obj[`${fq}day`]) || obj.day || [];
  if (!rows.length) throw new Error(`${stock.code} 无K线数据`);
  const bars = rows.slice(-days);
  return {
    dates: bars.map((b) => String(b[0])),
    closes: bars.map((b) => Number(b[2])),
  };
}

async function getBoardName(env, bk) {
  const list = safeJsonParse(await env.SUBSCRIPTIONS.get(SECTOR_LIST_KV_KEY));
  const hit = list?.boards?.find((b) => b.bk === bk);
  return hit?.name || bk;
}

async function refreshSectorBollinger(env, bk, opts = {}) {
  const days = opts.days || SECTOR_LOOKBACK_DAYS;
  const adjust = SECTOR_ADJUSTS.has(opts.adjust) ? opts.adjust : SECTOR_DEFAULT_ADJUST;
  const { ranking, source: rankingSource } = await fetchSectorRanking(env, bk);
  // 单只个股拉不到（停牌/退市/新股）不应拖垮整个板块，逐只兜底为 null 再过滤。
  const enriched = (
    await mapWithConcurrency(ranking, 5, async (s) => {
      try {
        const { dates, closes } = await fetchSectorCloses(s, days, adjust);
        if (!closes.length) return null;
        return {
          code: `${s.market === "1" ? "sh" : "sz"}${s.code}`,
          name: s.name,
          mcap: +(s.mcap / 1e8).toFixed(2),
          dates,
          closes,
        };
      } catch (err) {
        console.warn(`[sector] kline failed ${s.code}:`, err?.message || err);
        return null;
      }
    })
  ).filter(Boolean);
  if (!enriched.length) throw new Error(`板块 ${bk} 暂无可用K线数据，请稍后重试`);
  // 以成分股中最长的日期序列为公共横轴，尽量减少停牌股错位
  const axis = enriched.reduce((a, b) => (b.dates.length > a.dates.length ? b : a), enriched[0]);
  const payload = {
    updatedAt: new Date().toISOString(),
    bk,
    name: await getBoardName(env, bk),
    days,
    adjust,
    source: `ranking=${rankingSource} + kline=tencent-${adjust}`,
    latestTradeDate: axis.dates[axis.dates.length - 1] || "",
    dates: axis.dates,
    stocks: enriched.map((s) => ({
      code: s.code,
      name: s.name,
      mcap: s.mcap,
      closes: s.closes,
    })),
  };
  const isDefault = days === SECTOR_LOOKBACK_DAYS && adjust === SECTOR_DEFAULT_ADJUST;
  // 自定义参数的缓存加 TTL，避免长尾变体在 KV 里无限堆积
  await env.SUBSCRIPTIONS.put(
    sectorBollingerKey(bk, days, adjust),
    JSON.stringify(payload),
    isDefault ? undefined : { expirationTtl: 6 * 3600 }
  );
  return payload;
}

async function handleSectorBollinger(request, env) {
  const url = new URL(request.url);
  let bk = String(url.searchParams.get("bk") || PCB_BK_CODE).toUpperCase();
  if (!SECTOR_BK_RE.test(bk)) bk = PCB_BK_CODE;
  const forceRefresh = url.searchParams.get("refresh") === "1";
  const days =
    normalizePeriod(url.searchParams.get("days") ?? url.searchParams.get("period"), SECTOR_LOOKBACK_DAYS) ||
    SECTOR_LOOKBACK_DAYS;
  const adjustRaw = String(url.searchParams.get("adjust") || SECTOR_DEFAULT_ADJUST).toLowerCase();
  const adjust = SECTOR_ADJUSTS.has(adjustRaw) ? adjustRaw : SECTOR_DEFAULT_ADJUST;
  const opts = { days, adjust };
  await touchTrackedSector(env, bk).catch(() => {});
  if (forceRefresh) return json(await refreshSectorBollinger(env, bk, opts));
  const cached = safeJsonParse(await env.SUBSCRIPTIONS.get(sectorBollingerKey(bk, days, adjust)));
  if (cached?.stocks?.length) return json(cached);
  // KV 无缓存（首次访问该板块/该参数组合），实时拉一次填充
  return json(await refreshSectorBollinger(env, bk, opts));
}

// 兼容旧入口：/api/pcb-bollinger === /api/sector-bollinger?bk=BK0877
async function handlePcbBollinger(request, env) {
  return handleSectorBollinger(request, env);
}

// ---- 追踪集：记录被访问过的板块，供 cron 定时刷新（始终含 PCB） ----
async function touchTrackedSector(env, bk) {
  const cur = safeJsonParse(await env.SUBSCRIPTIONS.get(SECTOR_TRACKED_KV_KEY)) || { codes: [] };
  const codes = [bk, ...(cur.codes || []).filter((c) => c !== bk)].slice(0, SECTOR_TRACKED_MAX);
  await env.SUBSCRIPTIONS.put(
    SECTOR_TRACKED_KV_KEY,
    JSON.stringify({ codes, updatedAt: new Date().toISOString() })
  ).catch(() => {});
}

async function getTrackedSectors(env) {
  const cur = safeJsonParse(await env.SUBSCRIPTIONS.get(SECTOR_TRACKED_KV_KEY)) || { codes: [] };
  const set = new Set(cur.codes || []);
  set.add(PCB_BK_CODE); // 始终包含 PCB
  return [...set];
}

// ---- 板块清单（东财 概念 t:3 + 行业 t:2，按当日涨幅降序＝“热度”，供前端搜索/自选） ----
async function fetchSectorList() {
  // 东财单页最多 100 条（pz>100 会被截断），概念/行业各约 495/496 个，需翻页取全量。
  // 用 fid=f12 稳定排序翻页；f3 为涨跌幅×100（如 -108 = -1.08%），落库时除以 100。
  const PAGE = 100;
  const pageUrls = (t, pn) =>
    EASTMONEY_HOSTS.map(
      (h) =>
        `https://${h}/api/qt/clist/get` +
        `?pn=${pn}&pz=${PAGE}&po=1&np=1&fid=f12&fs=m:90+t:${t}&fields=f12,f14,f3`
    );
  const boards = [];
  const seen = new Set();
  for (const [t, type] of [["3", "concept"], ["2", "industry"]]) {
    try {
      let pn = 1;
      let total = Infinity;
      let got = 0;
      while (got < total && pn <= 12) {
        const data = await fetchJsonWithRetry(
          pageUrls(t, pn),
          { headers: { Accept: "application/json", Referer: "https://quote.eastmoney.com/" } },
          `eastmoney board list t:${t} p${pn}`
        );
        total = Number(data?.data?.total) || 0;
        const diff = data?.data?.diff;
        const list = Array.isArray(diff) ? diff : Object.values(diff || {});
        if (!list.length) break;
        for (const item of list) {
          const bk = String(item.f12 || "");
          if (!SECTOR_BK_RE.test(bk) || seen.has(bk)) continue;
          seen.add(bk);
          boards.push({ bk, name: String(item.f14 || bk), type, pct: +((Number(item.f3) || 0) / 100).toFixed(2) });
        }
        got += list.length;
        pn += 1;
      }
    } catch (err) {
      console.warn(`[sector] board list t:${t} failed:`, err?.message || err);
    }
  }
  boards.sort((a, b) => b.pct - a.pct);
  return boards;
}

async function refreshSectorList(env) {
  const boards = await fetchSectorList();
  const payload = { savedAt: new Date().toISOString(), savedDate: beijingDate(), boards };
  if (boards.length) {
    await env.SUBSCRIPTIONS.put(SECTOR_LIST_KV_KEY, JSON.stringify(payload)).catch(() => {});
  }
  return payload;
}

async function handleSectorList(env) {
  const cached = safeJsonParse(await env.SUBSCRIPTIONS.get(SECTOR_LIST_KV_KEY));
  const today = beijingDate();
  if (cached?.boards?.length && cached.savedDate === today) return json(cached);
  try {
    const payload = await refreshSectorList(env);
    if (payload.boards.length) return json(payload);
  } catch (err) {
    console.warn("[sector] list refresh failed:", err?.message || err);
  }
  if (cached?.boards?.length) return json(cached); // 拉取失败：回退过期缓存
  return json({ savedAt: new Date().toISOString(), savedDate: today, boards: [] });
}
