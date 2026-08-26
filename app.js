(function () {
  const { useEffect, useMemo, useRef, useState } = React;

  const BAND_MULTIPLIERS = [1, 2, 3];
  // 同源优先：页面挂在根域、子域名或 /boll 这类子路径下都能工作，
  // 请求跟着当前地址走，不会再跨域回 pages.dev（国内不可达）。
  // 需要指向别的后端时（本地开发等）仍可用 window.BOLL_ALERT_API_URL 显式覆盖。
  const API_BASE = window.BOLL_ALERT_API_URL ?? new URL("./", location.href).pathname.replace(/\/$/, "");
  const AUTH_STORAGE_KEY = "bollAuthSession";
  const CUSTOM_GROUPS_STORAGE_KEY = "bollCustomGroups";
  const CUSTOM_GROUPS_SEED_KEY = "bollCustomGroupsSeed";

  const PRESET_GROUPS = [
    {
      id: "preset-default",
      name: "默认",
      codes: ["688256", "688981"],
    },
  ];

  const WATCHLIST_SECTIONS = [
    {
      id: "default",
      label: "默认",
      stocks: [
        { code: "688256", name: "寒武纪" },
        { code: "688981", name: "中芯国际" },
      ],
    },
  ];

  const WATCHLIST = WATCHLIST_SECTIONS.flatMap((section) => section.stocks);

  const ADJUST_LABELS = {
    0: "不复权",
    1: "前复权",
    2: "后复权",
    3: "等比前复权",
  };

  const ALERT_CONDITION_LABELS = {
    outside: "高于上轨或低于下轨",
    above: "高于上轨",
    below: "低于下轨",
  };

  const FIELD_NAMES = [
    "date",
    "open",
    "close",
    "high",
    "low",
    "volume",
    "amount",
    "amplitude",
    "changePct",
    "changeAmount",
    "turnover",
  ];

  const PORTFOLIO_COLUMNS = [
    { key: "stock", label: "股票", width: 145 },
    { key: "date", label: "日期", width: 70 },
    { key: "close", label: "收盘", width: 82 },
    { key: "zone", label: "区间", width: 92 },
    { key: "middle", label: "中线", width: 86 },
    { key: "stddev", label: "标准差", width: 74 },
    { key: "k1", label: "K1上/下", width: 142 },
    { key: "k2", label: "K2上/下", width: 142 },
    { key: "k3", label: "K3上/下", width: 142 },
    { key: "chart", label: "图像", width: 66 },
  ];

  const DETAIL_COLUMNS = [
    { key: "date", label: "日期", width: 70 },
    { key: "close", label: "收盘", width: 86 },
    { key: "middle", label: "中线", width: 86 },
    { key: "stddev", label: "标准差", width: 72 },
    { key: "k1Upper", label: "K1上", width: 86 },
    { key: "k1Lower", label: "K1下", width: 86 },
    { key: "k2Upper", label: "K2上", width: 86 },
    { key: "k2Lower", label: "K2下", width: 86 },
    { key: "k3Upper", label: "K3上", width: 86 },
    { key: "k3Lower", label: "K3下", width: 86 },
  ];

  function classifyCloseZone(close, middle, bands) {
    if (close == null || middle == null || !bands?.[1] || !bands?.[2] || !bands?.[3]) return null;
    const { upper: k1u, lower: k1l } = bands[1];
    const { upper: k2u, lower: k2l } = bands[2];
    const { upper: k3u, lower: k3l } = bands[3];
    if (close > k3u) return { label: "突破K3↑", sortKey: 0, cssClass: "zone-extreme-up" };
    if (close > k2u) return { label: "K2-K3↑", sortKey: 1, cssClass: "zone-high-up" };
    if (close > k1u) return { label: "K1-K2↑", sortKey: 2, cssClass: "zone-mid-up" };
    if (close > middle) return { label: "中-K1↑", sortKey: 3, cssClass: "zone-low-up" };
    if (close > k1l) return { label: "K1-中↓", sortKey: 4, cssClass: "zone-low-dn" };
    if (close > k2l) return { label: "K2-K1↓", sortKey: 5, cssClass: "zone-mid-dn" };
    if (close > k3l) return { label: "K3-K2↓", sortKey: 6, cssClass: "zone-high-dn" };
    return { label: "突破K3↓", sortKey: 7, cssClass: "zone-extreme-dn" };
  }

  function classifyPriceBand(close) {
    if (close == null || Number.isNaN(close)) return { key: "pb-none", label: "无数据", order: 99 };
    if (close >= 500) return { key: "pb-500", label: "≥ 500 元", order: 0 };
    if (close >= 200) return { key: "pb-200", label: "200 ~ 500 元", order: 1 };
    if (close >= 100) return { key: "pb-100", label: "100 ~ 200 元", order: 2 };
    if (close >= 50) return { key: "pb-50", label: "50 ~ 100 元", order: 3 };
    if (close >= 20) return { key: "pb-20", label: "20 ~ 50 元", order: 4 };
    if (close >= 10) return { key: "pb-10", label: "10 ~ 20 元", order: 5 };
    return { key: "pb-0", label: "< 10 元", order: 6 };
  }

  function toDateInputValue(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function createDefaultForm() {
    const end = new Date();
    const start = new Date(end);
    start.setFullYear(start.getFullYear() - 1);
    return {
      code: "688256",
      marketMode: "auto",
      startDate: toDateInputValue(start),
      endDate: toDateInputValue(end),
      period: 20,
      adjust: "1",
    };
  }

  function createDefaultSubscription() {
    return {
      email: "",
      sendTime: "18:00",
      stocks: WATCHLIST.map((item) => item.code),
    };
  }

  function createDefaultAlertSubscription() {
    return {
      email: "",
      stocks: WATCHLIST.map((item) => item.code),
      multiplier: "2",
      condition: "outside",
    };
  }

  function createDefaultSubscriptionLookup() {
    return {
      email: "",
    };
  }

  function readStoredAuth() {
    try {
      const auth = JSON.parse(window.localStorage.getItem(AUTH_STORAGE_KEY) || "null");
      return auth?.token && auth?.email ? auth : null;
    } catch {
      return null;
    }
  }

  function readStoredCustomGroups() {
    try {
      const data = JSON.parse(window.localStorage.getItem(CUSTOM_GROUPS_STORAGE_KEY) || "[]");
      if (!Array.isArray(data)) return [];
      return data
        .filter((group) => group && typeof group.id === "string" && typeof group.name === "string")
        .map((group) => ({
          id: group.id,
          name: group.name,
          codes: Array.isArray(group.codes) ? group.codes.filter((code) => typeof code === "string") : [],
        }));
    } catch {
      return [];
    }
  }

  function makeGroupId(groups) {
    const ids = new Set(groups.map((group) => group.id));
    let n = 1;
    while (ids.has(`g${n}`)) n += 1;
    return `g${n}`;
  }

  function readSeededPresetIds() {
    try {
      const data = JSON.parse(window.localStorage.getItem(CUSTOM_GROUPS_SEED_KEY) || "[]");
      return Array.isArray(data) ? data.filter((id) => typeof id === "string") : [];
    } catch {
      return [];
    }
  }

  function initCustomGroups() {
    const stored = readStoredCustomGroups();
    const seeded = readSeededPresetIds();
    const existingIds = new Set(stored.map((group) => group.id));
    const toSeed = PRESET_GROUPS.filter((preset) => !seeded.includes(preset.id) && !existingIds.has(preset.id));
    if (toSeed.length === 0) return stored;
    try {
      window.localStorage.setItem(CUSTOM_GROUPS_SEED_KEY, JSON.stringify([...seeded, ...toSeed.map((preset) => preset.id)]));
    } catch {}
    return [...stored, ...toSeed.map((preset) => ({ id: preset.id, name: preset.name, codes: preset.codes.slice() }))];
  }

  function cleanSecurityInput(value) {
    return String(value || "")
      .toUpperCase()
      .replace(/\s+/g, "")
      .replace(/[^0-9A-Z.-]/g, "")
      .slice(0, 12);
  }

  function normalizeSecurityCode(value) {
    const compact = cleanSecurityInput(value);
    if (/^\d{1,5}$/.test(compact)) return compact.padStart(5, "0");
    if (/^\d{6}$/.test(compact)) return compact;
    const usSymbol = compact.replace(/\./g, "-");
    if (/^[A-Z](?:[A-Z0-9-]{0,8}[A-Z0-9])?$/.test(usSymbol)) return usSymbol;
    return "";
  }

  function isAutoReloadSecurityCode(value) {
    const compact = cleanSecurityInput(value);
    const usSymbol = compact.replace(/\./g, "-");
    return /^\d{5,6}$/.test(compact) || /^[A-Z](?:[A-Z0-9-]{0,8}[A-Z0-9])?$/.test(usSymbol);
  }

  function isUsSymbol(code) {
    return /^[A-Z](?:[A-Z0-9-]{0,8}[A-Z0-9])?$/.test(String(code || ""));
  }

  function marketLabel(market) {
    if (String(market).toUpperCase() === "US") return "\u7f8e\u80a1";
    if (String(market) === "116") return "港股";
    if (String(market) === "1") return "沪市";
    return "深市/北交所";
  }

  function padDate(date) {
    return date.replaceAll("-", "");
  }

  function coercePeriod(value) {
    const period = Number(value);
    return Number.isInteger(period) && period >= 2 && period <= 250 ? period : null;
  }

  function periodError(value) {
    return coercePeriod(value) ? "" : "周期 N 需要是 2 到 250 之间的整数。";
  }

  function warmupStartDate(form) {
    const start = new Date(`${form.startDate}T00:00:00`);
    const period = coercePeriod(form.period) || 20;
    start.setDate(start.getDate() - Math.ceil(period * 2.2 + 20));
    return toDateInputValue(start);
  }

  function inferMarket(code) {
    const normalized = normalizeSecurityCode(code);
    if (isUsSymbol(normalized)) return "US";
    if (normalized.length === 5) return "116";
    if (/^(5|6|688|689)/.test(normalized)) return "1";
    return "0";
  }

  // —— 股票池批量导入：市场识别 / 解析 / 名称（端口自 pool-data.js）——
  // 市场大类：A 股 / 港股 / 美股
  function marketCategory(code) {
    if (isUsSymbol(code)) return "US";
    if (/^\d{5}$/.test(code)) return "HK";
    if (/^\d{6}$/.test(code)) return "A";
    return null;
  }

  const MARKET_SHORT = { A: "A股", HK: "港股", US: "美股" };
  const MARKET_DOT = { A: "mk-a", HK: "mk-hk", US: "mk-us" };

  // A 股交易所子类（沪 / 深 / 北）
  function marketSub(code) {
    if (marketCategory(code) !== "A") return "";
    if (/^(60|68|51|56|58|11|50|90)/.test(code)) return "沪";
    if (/^(00|30|15|16|12|13|18|39)/.test(code)) return "深";
    if (/^(8|4|92)/.test(code)) return "北";
    return "";
  }

  // 本地名称库（演示/即时识别用；真实名称仍由行情接口补全）
  const NAME_DB = {
    "688256": "寒武纪", "688802": "沐曦股份", "688795": "摩尔线程", "688041": "海光信息",
    "002230": "科大讯飞", "000977": "浪潮信息", "603019": "中科曙光", "688111": "金山办公",
    "300308": "中际旭创", "300502": "新易盛", "601360": "三六零", "002415": "海康威视",
    "688981": "中芯国际", "002371": "北方华创", "603501": "韦尔股份", "688012": "中微公司",
    "603986": "兆易创新", "688008": "澜起科技", "002049": "紫光国微", "600584": "长电科技",
    "300750": "宁德时代", "002594": "比亚迪", "300274": "阳光电源", "300014": "亿纬锂能",
    "002074": "国轩高科", "688390": "固德威", "300438": "鹏辉能源",
    "002460": "赣锋锂业", "002466": "天齐锂业", "603799": "华友钴业", "002497": "雅化集团",
    "002738": "中矿资源", "603993": "洛阳钼业", "002240": "盛新锂能",
    "600519": "贵州茅台", "000858": "五粮液", "601318": "中国平安", "000001": "平安银行",
    "600276": "恒瑞医药", "002475": "立讯精密", "300760": "迈瑞医疗", "601899": "紫金矿业",
    "000651": "格力电器", "000333": "美的集团", "600900": "长江电力", "601012": "隆基绿能",
    "002129": "TCL中环", "600030": "中信证券", "601166": "兴业银行", "000725": "京东方A",
    "002714": "牧原股份", "600887": "伊利股份", "601888": "中国中免", "600036": "招商银行",
    "00700": "腾讯控股", "01810": "小米集团-W", "09988": "阿里巴巴-W", "03690": "美团-W",
    "00941": "中国移动", "09618": "京东集团-SW", "02020": "安踏体育", "01024": "快手-W",
    "09999": "网易-S", "00388": "香港交易所", "01299": "友邦保险", "02318": "中国平安",
    "AAPL": "苹果", "MSFT": "微软", "NVDA": "英伟达", "TSLA": "特斯拉", "GOOGL": "谷歌A",
    "AMZN": "亚马逊", "META": "Meta", "AMD": "AMD", "INTC": "英特尔", "NFLX": "奈飞",
    "AVGO": "博通", "QCOM": "高通", "ORCL": "甲骨文", "BABA": "阿里巴巴", "PDD": "拼多多",
    "JD": "京东", "NIO": "蔚来", "BIDU": "百度", "ADBE": "Adobe", "CRM": "Salesforce",
  };

  function lookupName(code) {
    if (NAME_DB[code]) return NAME_DB[code];
    const stock = WATCHLIST.find((item) => item.code === code);
    return stock ? stock.name : null;
  }

  // 把一段自由文本拆成原始 token：逗号 / 空格 / 换行 / 制表 / 分号 / 顿号 / 竖线
  function tokenize(text) {
    return String(text || "")
      .split(/[\s,;，；、|]+/)
      .map((token) => token.trim())
      .filter(Boolean);
  }

  // 解析单个 token；poolSet 为股票池现有代码集合（去重），batchSeen 为本次粘贴内已见集合
  // status: ok | duplicate | invalid；dupOf: 'pool' | 'batch'
  function classifyToken(raw, poolSet, batchSeen) {
    const code = normalizeSecurityCode(raw);
    if (!code) return { raw, code: "", market: null, name: null, status: "invalid" };
    const market = marketCategory(code);
    const name = lookupName(code);
    if (poolSet && poolSet.has(code)) return { raw, code, market, name, status: "duplicate", dupOf: "pool" };
    if (batchSeen && batchSeen.has(code)) return { raw, code, market, name, status: "duplicate", dupOf: "batch" };
    if (batchSeen) batchSeen.add(code);
    return { raw, code, market, name, status: "ok" };
  }

  // 解析一组 chip（每个有自己的 raw 与 id），返回带状态的结果数组
  function parseChips(chips, poolSet) {
    const batchSeen = new Set();
    return chips.map((chip) => ({ id: chip.id, ...classifyToken(chip.raw, poolSet, batchSeen) }));
  }

  let _poolUid = 0;
  function poolUid(prefix = "id") {
    _poolUid += 1;
    return `${prefix}-${_poolUid}`;
  }

  function formatNumber(value, digits = 2) {
    if (value === null || value === undefined || Number.isNaN(value)) return "--";
    return Number(value).toLocaleString("zh-CN", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function formatShortDate(value) {
    if (!value || typeof value !== "string") return "--";
    const parts = value.split("-");
    return parts.length === 3 ? `${parts[1]}-${parts[2]}` : value;
  }

  function formatBandPair(band) {
    if (!band) return "--";
    return `${formatNumber(band.upper)}/${formatNumber(band.lower)}`;
  }

  function formatDateTime(value) {
    if (!value) return "暂无";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString("zh-CN", {
      hour12: false,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function parseKline(row) {
    const parts = row.split(",");
    return FIELD_NAMES.reduce((record, key, index) => {
      record[key] = index === 0 ? parts[index] : Number(parts[index]);
      return record;
    }, {});
  }

  // 行情时间各市场格式不一（20260603120549 / 2026/06/03 11:59:59 / 2026-06-02 16:00:01），
  // 统一抽数字后取 月-日 时:分 展示。
  function formatQuoteTime(raw) {
    const d = String(raw || "").replace(/\D/g, "");
    if (d.length < 12) return "";
    return `${d.slice(4, 6)}-${d.slice(6, 8)} ${d.slice(8, 10)}:${d.slice(10, 12)}`;
  }

  function computeBollingerBands(rows, period) {
    const safePeriod = coercePeriod(period);
    if (!safePeriod) return rows.map((row) => ({ ...row, middle: null, standardDeviation: null, bands: {} }));

    return rows.map((row, index) => {
      if (index + 1 < safePeriod) {
        return { ...row, middle: null, standardDeviation: null, bands: {} };
      }

      const windowRows = rows.slice(index + 1 - safePeriod, index + 1);
      const middle = windowRows.reduce((sum, item) => sum + item.close, 0) / safePeriod;
      const variance = windowRows.reduce((sum, item) => sum + (item.close - middle) ** 2, 0) / safePeriod;
      const standardDeviation = Math.sqrt(variance);
      const bands = Object.fromEntries(
        BAND_MULTIPLIERS.map((multiplier) => [
          multiplier,
          {
            upper: middle + multiplier * standardDeviation,
            lower: middle - multiplier * standardDeviation,
          },
        ])
      );

      return { ...row, middle, standardDeviation, bands };
    });
  }

  function buildEastmoneyUrl(form) {
    const code = normalizeSecurityCode(form.code);
    const market = form.marketMode === "auto" ? inferMarket(code) : form.marketMode;
    const params = new URLSearchParams({
      secid: `${market}.${code}`,
      fields1: "f1,f2,f3,f4,f5,f6",
      fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
      klt: "101",
      fqt: form.adjust,
      beg: padDate(warmupStartDate(form)),
      end: padDate(form.endDate),
    });
    return `https://push2his.eastmoney.com/api/qt/stock/kline/get?${params}`;
  }

  function buildProxyUrl(form) {
    const params = new URLSearchParams({
      code: normalizeSecurityCode(form.code),
      marketMode: form.marketMode,
      adjust: form.adjust,
      beg: padDate(warmupStartDate(form)),
      end: padDate(form.endDate),
    });
    return `${API_BASE}/api/klines?${params}`;
  }

  function queryKey(form) {
    return [
      normalizeSecurityCode(form.code),
      form.marketMode,
      form.adjust,
      form.startDate,
      form.endDate,
      coercePeriod(form.period) || form.period,
    ].join("|");
  }

  // 仅用于离线 / 预览演示：当行情接口不可达时，用确定性的示例数据填充界面。
  // 上线到真实环境时，把它改为 false，让接口失败回到正常报错。
  const ENABLE_DEMO_FALLBACK = false;

  function hashCode(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function makeDemoPayload(form) {
    const code = normalizeSecurityCode(form.code) || "688256";
    const name = (WATCHLIST.find((s) => s.code === code) || {}).name || code;
    const market = inferMarket(code);
    const seed = hashCode(code) || 1;
    let rng = seed;
    const rand = () => {
      rng = (Math.imul(rng, 1103515245) + 12345) & 0x7fffffff;
      return rng / 0x7fffffff;
    };
    let price = 8 + (seed % 520) + rand() * 12;
    const end = new Date(`${form.endDate}T00:00:00`);
    const dates = [];
    const cursor = new Date(end);
    while (dates.length < 300) {
      const dow = cursor.getDay();
      if (dow !== 0 && dow !== 6) dates.push(new Date(cursor));
      cursor.setDate(cursor.getDate() - 1);
    }
    dates.reverse();
    let trend = (rand() - 0.5) * 0.005;
    const klines = dates.map((d, i) => {
      if (i % 28 === 0) trend = (rand() - 0.5) * 0.006;
      const drift = trend + (rand() - 0.5) * 0.028;
      const open = price;
      price = Math.max(1, price * (1 + drift));
      const close = price;
      const high = Math.max(open, close) * (1 + rand() * 0.011);
      const low = Math.min(open, close) * (1 - rand() * 0.011);
      const vol = Math.round(8e5 + rand() * 6e6);
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const changeAmount = close - open;
      return [
        ds,
        open.toFixed(2),
        close.toFixed(2),
        high.toFixed(2),
        low.toFixed(2),
        vol,
        Math.round(vol * close),
        (((high - low) / open) * 100).toFixed(2),
        ((changeAmount / open) * 100).toFixed(2),
        changeAmount.toFixed(2),
        (rand() * 3).toFixed(2),
      ].join(",");
    });
    return { data: { code, name, market, source: "demo", klines } };
  }

  async function fetchKlines(form) {
    const urls = API_BASE ? [buildProxyUrl(form)] : [buildEastmoneyUrl(form)];
    let lastError;
    for (const url of urls) {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`行情接口返回 ${response.status}`);
        const payload = await response.json();
        if (!payload.data || !Array.isArray(payload.data.klines) || payload.data.klines.length === 0) {
          throw new Error("没有取到日线数据，请检查代码、市场或日期范围。");
        }
        return payload;
      } catch (err) {
        lastError = err;
      }
    }
    if (ENABLE_DEMO_FALLBACK) return makeDemoPayload(form);
    throw lastError || new Error("拉取行情失败。");
  }

  function validateForm(form) {
    if (!normalizeSecurityCode(form.code)) return "\u8bf7\u8f93\u5165 A \u80a1/ETF 6 \u4f4d\u4ee3\u7801\u3001\u6e2f\u80a1 1-5 \u4f4d\u4ee3\u7801\u6216\u7f8e\u80a1\u82f1\u6587\u4ee3\u7801\uff0c\u4f8b\u5982 688256\u3001515310\u300100700\u3001AAPL\u3002";
    if (!form.startDate || !form.endDate) return "请选择开始日期和结束日期。";
    if (form.startDate > form.endDate) return "开始日期不能晚于结束日期。";
    if (periodError(form.period)) return periodError(form.period);
    return "";
  }

  function validateSubscription(subscription, isLoggedIn) {
    if (!isLoggedIn && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subscription.email.trim())) return "请输入有效邮箱，或先登录使用账户邮箱。";
    if (!subscription.sendTime) return "请选择每天推送时间。";
    if (subscription.stocks.length === 0) return "请至少选择一只股票。";
    return "";
  }

  function validateAlertSubscription(subscription, isLoggedIn) {
    if (!isLoggedIn && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subscription.email.trim())) return "请输入有效邮箱，或先登录使用账户邮箱。";
    if (subscription.stocks.length === 0) return "请至少选择一只股票。";
    if (!["1", "2", "3"].includes(subscription.multiplier)) return "请选择 1、2 或 3 倍标准差。";
    if (!ALERT_CONDITION_LABELS[subscription.condition]) return "请选择有效的预警条件。";
    return "";
  }

  function validateSubscriptionLookup(lookup) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lookup.email.trim())) return "请输入有效邮箱。";
    return "";
  }

  function defaultPanelOpen() {
    return false;
  }

  function sortPinnedColumns(columns, pinnedColumns) {
    return columns.filter((column) => pinnedColumns.includes(column.key)).map((column) => column.key);
  }

  function togglePinnedColumn(columns, pinnedColumns, key) {
    const next = pinnedColumns.includes(key) ? pinnedColumns.filter((item) => item !== key) : [...pinnedColumns, key];
    return sortPinnedColumns(columns, next);
  }

  function tableMinWidth(columns) {
    return columns.reduce((sum, column) => sum + column.width, 0);
  }

  function cellProps(columns, pinnedColumns, key, className = "") {
    const column = columns.find((item) => item.key === key);
    const sortedPinned = columns.filter((item) => pinnedColumns.includes(item.key));
    const pinnedIndex = sortedPinned.findIndex((item) => item.key === key);
    const isPinned = pinnedIndex !== -1;
    const isPinnedLast = isPinned && pinnedIndex === sortedPinned.length - 1;
    const left = sortedPinned.slice(0, pinnedIndex).reduce((sum, item) => sum + item.width, 0);
    return {
      className: [className, isPinned ? "pinned-cell" : "", isPinnedLast ? "pinned-edge" : ""].filter(Boolean).join(" "),
      style: {
        width: `${column.width}px`,
        minWidth: `${column.width}px`,
        maxWidth: `${column.width}px`,
        ...(isPinned ? { left: `${left}px` } : {}),
      },
    };
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

  function ColumnPinControls({ columns, pinnedColumns, onToggle }) {
    return React.createElement(
      "details",
      { className: "pin-menu" },
      React.createElement("summary", null, `固定列 ${pinnedColumns.length}`),
      React.createElement(
        "div",
        { className: "pin-options" },
        columns.map((column) =>
          React.createElement(
            "label",
            { key: column.key, className: "pin-option" },
            React.createElement("input", { type: "checkbox", checked: pinnedColumns.includes(column.key), onChange: () => onToggle(column.key) }),
            React.createElement("span", null, column.label)
          )
        )
      )
    );
  }

  function QueryStatus({ loading, portfolioLoading, stockLabel, stockCount, floating = false }) {
    if (!loading && !portfolioLoading) return null;
    const title = loading ? "查询中" : "已选股票更新中";
    const detail = loading
      ? `正在拉取 ${stockLabel} 的日线行情，并重新计算中线和标准差轨道。`
      : `正在更新 ${stockCount} 只已选股票的最新中线、标准差和上下边界。`;
    return React.createElement(
      "div",
      { className: floating ? "loading-status loading-toast" : "loading-status", role: "status", "aria-live": "polite" },
      React.createElement("span", { className: "loading-spinner", "aria-hidden": "true" }),
      React.createElement(
        "div",
        null,
        React.createElement("strong", null, title),
        React.createElement("span", null, detail)
      )
    );
  }

  function StockTags({ stocks }) {
    if (!stocks || stocks.length === 0) return React.createElement("span", { className: "muted" }, "暂无股票");
    return React.createElement(
      "div",
      { className: "stock-tags" },
      stocks.map((stock) => React.createElement("span", { key: stock.code }, `${stock.name} ${stock.code}`))
    );
  }

  function SubscriptionStatusCard({ type, data, onCancel, cancellingType }) {
    if (!data) {
      return React.createElement("div", { className: "subscription-card empty" }, type === "daily" ? "没有每日汇总订阅。" : "没有预警订阅。");
    }
    const isDaily = type === "daily";
    const cancelLabel = isDaily ? "取消每日订阅" : "取消预警订阅";
    const cancelling = cancellingType === type;
    return React.createElement(
      "div",
      { className: "subscription-card" },
      React.createElement(
        "div",
        { className: "subscription-card-head" },
        React.createElement("h4", null, isDaily ? "每日汇总订阅" : "预警订阅"),
        React.createElement("button", { type: "button", className: "danger-action", onClick: () => onCancel(type), disabled: Boolean(cancellingType) }, cancelling ? "取消中..." : cancelLabel)
      ),
      React.createElement(
        "div",
        { className: "subscription-meta" },
        React.createElement("span", null, isDaily ? `推送时间：${data.sendTime}` : `规则：±${data.multiplier}σ · ${data.conditionLabel}`),
        React.createElement("span", null, `周期 N=${data.period}`),
        React.createElement("span", null, isDaily ? `上次发送：${data.lastSentDate || "暂无"}` : `上次预警：${formatDateTime(data.lastAlertAt)}`),
        React.createElement("span", null, `更新时间：${formatDateTime(data.updatedAt)}`)
      ),
      React.createElement(StockTags, { stocks: data.stocks })
    );
  }

  function Stat({ label, value, tone }) {
    return React.createElement(
      "div",
      { className: "stat" },
      React.createElement("span", null, label),
      React.createElement("strong", { className: tone || "" }, value)
    );
  }

  function downsamplePoints(points, maxPoints = 260) {
    if (points.length <= maxPoints) return points;
    const step = (points.length - 1) / (maxPoints - 1);
    return Array.from({ length: maxPoints }, (_, index) => points[Math.round(index * step)]);
  }

  function MiniChart({ rows }) {
    const points = downsamplePoints(rows.filter((row) => row.middle !== null));
    const pathData = useMemo(() => {
      if (points.length < 2) return "";
      const values = points.flatMap((row) => [
        row.close,
        row.middle,
        row.bands[1].upper,
        row.bands[1].lower,
        row.bands[2].upper,
        row.bands[2].lower,
        row.bands[3].upper,
        row.bands[3].lower,
      ]);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const spread = max - min || 1;
      const scaleX = (index) => (index / (points.length - 1)) * 1000;
      const scaleY = (value) => 280 - ((value - min) / spread) * 240;
      const makePath = (getter) =>
        points
          .map((row, index) => `${index === 0 ? "M" : "L"} ${scaleX(index).toFixed(2)} ${scaleY(getter(row)).toFixed(2)}`)
          .join(" ");

      return {
        close: makePath((row) => row.close),
        middle: makePath((row) => row.middle),
        upper1: makePath((row) => row.bands[1].upper),
        lower1: makePath((row) => row.bands[1].lower),
        upper2: makePath((row) => row.bands[2].upper),
        lower2: makePath((row) => row.bands[2].lower),
        upper3: makePath((row) => row.bands[3].upper),
        lower3: makePath((row) => row.bands[3].lower),
      };
    }, [points]);

    if (!pathData) {
      return React.createElement("div", { className: "empty-chart" }, "数据达到周期 N 后显示走势");
    }

    return React.createElement(
      "svg",
      { className: "chart", viewBox: "0 0 1000 320", role: "img", "aria-label": "收盘价与布林带三组上下轨走势" },
      React.createElement("line", { x1: "0", y1: "40", x2: "1000", y2: "40", className: "grid-line" }),
      React.createElement("line", { x1: "0", y1: "160", x2: "1000", y2: "160", className: "grid-line" }),
      React.createElement("line", { x1: "0", y1: "280", x2: "1000", y2: "280", className: "grid-line" }),
      React.createElement("path", { d: pathData.upper3, className: "band-line band-3" }),
      React.createElement("path", { d: pathData.lower3, className: "band-line band-3" }),
      React.createElement("path", { d: pathData.upper2, className: "band-line band-2" }),
      React.createElement("path", { d: pathData.lower2, className: "band-line band-2" }),
      React.createElement("path", { d: pathData.upper1, className: "band-line band-1" }),
      React.createElement("path", { d: pathData.lower1, className: "band-line band-1" }),
      React.createElement("path", { d: pathData.close, className: "price-line" }),
      React.createElement("path", { d: pathData.middle, className: "middle-line" })
    );
  }

  // —— 股票池批量导入：共享组件（端口自 pool-components.jsx）——
  function MarketBadge({ code, market, showSub = true }) {
    const cat = market || marketCategory(code);
    const dot = MARKET_DOT[cat] || "mk-none";
    let label = MARKET_SHORT[cat] || "未知";
    if (showSub && cat === "A") {
      const sub = marketSub(code);
      if (sub) label = `${sub} · A股`;
    }
    return React.createElement("span", { className: "mk-badge" }, React.createElement("span", { className: `mk-dot ${dot}` }), label);
  }

  function CodeChip({ item, editing, editValue, onEditChange, onStartEdit, onCommitEdit, onRemove }) {
    const inputRef = useRef(null);
    useEffect(() => {
      if (editing && inputRef.current) inputRef.current.focus();
    }, [editing]);

    if (item.status === "invalid") {
      return React.createElement(
        "span",
        { className: "code-chip invalid", onClick: () => !editing && onStartEdit(item.id) },
        editing
          ? React.createElement("input", {
              ref: inputRef,
              className: "cc-edit",
              value: editValue,
              onChange: (e) => onEditChange(cleanSecurityInput(e.target.value)),
              onKeyDown: (e) => {
                if (e.key === "Enter") onCommitEdit(item.id);
                if (e.key === "Escape") onCommitEdit(item.id);
              },
              onBlur: () => onCommitEdit(item.id),
              onClick: (e) => e.stopPropagation(),
            })
          : React.createElement(
              React.Fragment,
              null,
              React.createElement("span", { className: "cc-warn-ico" }, "⚠"),
              React.createElement("span", null, item.raw || "?")
            ),
        React.createElement("button", { type: "button", className: "cc-x", title: "移除", onClick: (e) => { e.stopPropagation(); onRemove(item.id); } }, "×")
      );
    }

    return React.createElement(
      "span",
      { className: `code-chip ${item.status}` },
      React.createElement("span", { className: `mk-dot ${MARKET_DOT[item.market] || "mk-none"}` }),
      React.createElement("span", null, item.code),
      item.name
        ? React.createElement("span", { className: "cc-name" }, item.name)
        : item.status === "ok"
          ? React.createElement("span", { className: "cc-name" }, "名称待获取")
          : null,
      item.status === "duplicate" && React.createElement("span", { className: "cc-name", style: { opacity: 0.85 } }, item.dupOf === "pool" ? "已在池" : "重复"),
      React.createElement("button", { type: "button", className: "cc-x", title: "移除", onClick: () => onRemove(item.id) }, "×")
    );
  }

  const POOL_SAMPLE = "600519, 000858 600276\n00700 09988\nAAPL NVDA AMD\n688256 12345678";

  function ImportModal({ open, onClose, poolCodes, groups, onImport }) {
    const [mode, setMode] = useState("paste");
    const [chips, setChips] = useState([]);
    const [inputValue, setInputValue] = useState("");
    const [focused, setFocused] = useState(false);
    const [editingId, setEditingId] = useState(null);
    const [editValue, setEditValue] = useState("");
    const [dragOver, setDragOver] = useState(false);
    const [groupChoice, setGroupChoice] = useState("__none__");
    const [newGroupName, setNewGroupName] = useState("");
    const [autoInclude, setAutoInclude] = useState(true);
    const [fileName, setFileName] = useState("");
    const inputRef = useRef(null);
    const fileRef = useRef(null);

    const poolSet = useMemo(() => new Set(poolCodes), [poolCodes]);
    const parsed = useMemo(() => parseChips(chips, poolSet), [chips, poolSet]);
    const counts = useMemo(() => {
      let ok = 0, dup = 0, bad = 0;
      parsed.forEach((p) => {
        if (p.status === "ok") ok += 1;
        else if (p.status === "duplicate") dup += 1;
        else bad += 1;
      });
      return { ok, dup, bad };
    }, [parsed]);

    useEffect(() => {
      if (!open) {
        setChips([]); setInputValue(""); setEditingId(null); setEditValue("");
        setGroupChoice("__none__"); setNewGroupName(""); setMode("paste"); setFileName("");
      }
    }, [open]);

    useEffect(() => {
      if (!open) return;
      const onKey = (e) => { if (e.key === "Escape" && editingId == null) onClose(); };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [open, editingId, onClose]);

    if (!open) return null;

    function addRaws(raws) {
      const fresh = raws.map((raw) => ({ id: poolUid("chip"), raw }));
      if (fresh.length) setChips((cur) => [...cur, ...fresh]);
    }
    function handleInputChange(v) {
      if (/[\s,;，；、|]/.test(v)) {
        const segs = v.split(/[\s,;，；、|]+/);
        const trailing = segs.pop();
        addRaws(segs.filter(Boolean));
        setInputValue(trailing);
      } else {
        setInputValue(v);
      }
    }
    function handlePaste(e) {
      const text = e.clipboardData.getData("text");
      if (text && /[\s,;，；、|]/.test(text)) {
        e.preventDefault();
        addRaws(tokenize(text));
        setInputValue("");
      }
    }
    function handleKeyDown(e) {
      if (e.key === "Enter") {
        e.preventDefault();
        if (inputValue.trim()) { addRaws([inputValue.trim()]); setInputValue(""); }
      } else if (e.key === "Backspace" && inputValue === "" && chips.length) {
        setChips((cur) => cur.slice(0, -1));
      }
    }
    function removeChip(id) { setChips((cur) => cur.filter((c) => c.id !== id)); }
    function startEdit(id) { const chip = chips.find((c) => c.id === id); setEditingId(id); setEditValue(chip ? chip.raw : ""); }
    function commitEdit(id) {
      const val = editValue.trim();
      setChips((cur) => {
        if (!val) return cur.filter((c) => c.id !== id);
        const toks = tokenize(val);
        if (toks.length <= 1) return cur.map((c) => (c.id === id ? { ...c, raw: val } : c));
        const out = [];
        cur.forEach((c) => {
          if (c.id === id) toks.forEach((t) => out.push({ id: poolUid("chip"), raw: t }));
          else out.push(c);
        });
        return out;
      });
      setEditingId(null); setEditValue("");
    }
    function readFile(file) {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => { setFileName(file.name); addRaws(tokenize(String(reader.result || ""))); };
      reader.readAsText(file);
    }
    function clearAll() { setChips([]); setInputValue(""); setFileName(""); }
    function doImport() {
      const items = parsed.filter((p) => p.status === "ok").map((p) => ({ code: p.code, name: p.name, market: p.market }));
      if (!items.length) return;
      onImport({ items, groupChoice, newGroupName: newGroupName.trim(), autoInclude });
    }
    const importDisabled = counts.ok === 0 || (groupChoice === "__new__" && !newGroupName.trim());

    return React.createElement(
      "div",
      { className: "import-overlay", onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(); } },
      React.createElement(
        "div",
        { className: "import-modal", role: "dialog", "aria-modal": "true" },
        React.createElement(
          "div",
          { className: "import-head" },
          React.createElement("div", null,
            React.createElement("h3", null, "批量导入股票"),
            React.createElement("p", null, "粘贴一串代码或上传文件，系统自动识别市场与名称、去重，并可整批归入一个分组。")
          ),
          React.createElement("button", { type: "button", className: "import-close", onClick: onClose, title: "关闭 (ESC)" }, "×")
        ),
        React.createElement(
          "div",
          { className: "import-body" },
          React.createElement(
            "div",
            { className: "seg" },
            React.createElement("button", { type: "button", className: mode === "paste" ? "seg-btn active" : "seg-btn", onClick: () => setMode("paste") }, "粘贴代码"),
            React.createElement("button", { type: "button", className: mode === "file" ? "seg-btn active" : "seg-btn", onClick: () => setMode("file") }, "上传文件")
          ),
          mode === "paste"
            ? React.createElement(
                React.Fragment,
                null,
                React.createElement(
                  "div",
                  { className: focused ? "tag-field focused" : "tag-field", onClick: () => inputRef.current && inputRef.current.focus() },
                  parsed.map((item) => React.createElement(CodeChip, { key: item.id, item, editing: editingId === item.id, editValue, onEditChange: setEditValue, onStartEdit: startEdit, onCommitEdit: commitEdit, onRemove: removeChip })),
                  chips.length === 0 && inputValue === "" && React.createElement("span", { className: "ghost" }, "粘贴或输入代码，用逗号 / 空格 / 换行分隔…"),
                  React.createElement("input", {
                    ref: inputRef, className: "tag-input", value: inputValue, inputMode: "text",
                    onChange: (e) => handleInputChange(e.target.value.toUpperCase()),
                    onPaste: handlePaste, onKeyDown: handleKeyDown, onFocus: () => setFocused(true), onBlur: () => setFocused(false),
                  })
                ),
                React.createElement(
                  "p",
                  { className: "example-line" },
                  "支持 A股6位 / 港股1–5位 / 美股代码混合，例如 ",
                  React.createElement("code", null, "688256 600519 00700 AAPL"),
                  "。",
                  chips.length === 0 && React.createElement("span", { className: "fill", onClick: () => addRaws(tokenize(POOL_SAMPLE)) }, "　填入示例")
                )
              )
            : React.createElement(
                React.Fragment,
                null,
                React.createElement(
                  "div",
                  {
                    className: dragOver ? "drop-zone drag" : "drop-zone",
                    onClick: () => fileRef.current && fileRef.current.click(),
                    onDragOver: (e) => { e.preventDefault(); setDragOver(true); },
                    onDragLeave: () => setDragOver(false),
                    onDrop: (e) => { e.preventDefault(); setDragOver(false); readFile(e.dataTransfer.files[0]); },
                  },
                  React.createElement(
                    "svg",
                    { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" },
                    React.createElement("path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }),
                    React.createElement("polyline", { points: "17 8 12 3 7 8" }),
                    React.createElement("line", { x1: "12", y1: "3", x2: "12", y2: "15" })
                  ),
                  React.createElement("strong", null, fileName ? `已读取：${fileName}` : "拖拽 CSV / TXT 文件到这里"),
                  React.createElement("span", null, "或 ", React.createElement("span", { className: "browse" }, "点击选择文件"), "　·　逐行或逗号分隔的代码均可"),
                  React.createElement("input", { ref: fileRef, type: "file", accept: ".csv,.txt,text/csv,text/plain", style: { display: "none" }, onChange: (e) => readFile(e.target.files[0]) })
                ),
                chips.length > 0 &&
                  React.createElement(
                    "div",
                    { className: "tag-field", style: { minHeight: "auto" } },
                    parsed.map((item) => React.createElement(CodeChip, { key: item.id, item, editing: editingId === item.id, editValue, onEditChange: setEditValue, onStartEdit: startEdit, onCommitEdit: commitEdit, onRemove: removeChip }))
                  )
              ),
          chips.length > 0 &&
            React.createElement(
              "div",
              { className: "import-summary" },
              React.createElement("div", { className: "sum-cell sum-ok" }, React.createElement("b", null, counts.ok), React.createElement("span", null, "可识别 · 将导入")),
              React.createElement("div", { className: "sum-cell sum-dup" }, React.createElement("b", null, counts.dup), React.createElement("span", null, "重复 · 自动跳过")),
              React.createElement("div", { className: "sum-cell sum-bad" }, React.createElement("b", null, counts.bad), React.createElement("span", null, "无法识别 · 点击修正"))
            ),
          React.createElement(
            "div",
            { className: "import-opts" },
            React.createElement(
              "div",
              { className: "opt-line" },
              React.createElement("span", { style: { fontSize: "12.5px", fontWeight: 600, color: "var(--ink-2)" } }, "导入到分组"),
              React.createElement(
                "div",
                { className: "group-pick" },
                React.createElement(
                  "select",
                  { value: groupChoice, onChange: (e) => setGroupChoice(e.target.value) },
                  React.createElement("option", { value: "__none__" }, "不分组"),
                  groups.map((g) => React.createElement("option", { key: g.id, value: g.id }, g.name)),
                  React.createElement("option", { value: "__new__" }, "+ 新建分组…")
                ),
                groupChoice === "__new__" && React.createElement("input", { value: newGroupName, placeholder: "新分组名称", maxLength: "12", onChange: (e) => setNewGroupName(e.target.value) })
              )
            ),
            React.createElement(
              "div",
              { className: "opt-line" },
              React.createElement("label", { htmlFor: "auto-inc" }, "导入后自动勾选「纳入订阅 / 预警」"),
              React.createElement(
                "span",
                { className: "toggle" },
                React.createElement("input", { id: "auto-inc", type: "checkbox", checked: autoInclude, onChange: (e) => setAutoInclude(e.target.checked) }),
                React.createElement("span", { className: "track" })
              )
            )
          )
        ),
        React.createElement(
          "div",
          { className: "import-foot" },
          React.createElement(
            "div",
            { className: "foot-note" },
            chips.length > 0
              ? React.createElement(React.Fragment, null, "将导入 ", React.createElement("strong", null, counts.ok), " 只 · 跳过 ", React.createElement("strong", null, counts.dup), " 重复", counts.bad > 0 && React.createElement(React.Fragment, null, " · ", React.createElement("strong", null, counts.bad), " 待修正"))
              : "尚未输入代码"
          ),
          React.createElement(
            "div",
            { className: "foot-actions" },
            chips.length > 0 && React.createElement("button", { type: "button", className: "secondary-action", onClick: clearAll }, "清空"),
            React.createElement("button", { type: "button", className: "secondary-action", onClick: onClose }, "取消"),
            React.createElement("button", { type: "button", onClick: doImport, disabled: importDisabled }, `导入 ${counts.ok > 0 ? counts.ok + " 只" : ""}`)
          )
        )
      )
    );
  }

  function App() {
    const [auth, setAuth] = useState(readStoredAuth);
    const [form, setForm] = useState(createDefaultForm());
    const [subscription, setSubscription] = useState(createDefaultSubscription());
    const [alertSubscription, setAlertSubscription] = useState(createDefaultAlertSubscription());
    const [subscriptionLookup, setSubscriptionLookup] = useState(createDefaultSubscriptionLookup());
    const [customStockCode, setCustomStockCode] = useState("");
    const [alertCustomStockCode, setAlertCustomStockCode] = useState("");
    const [privateStockCode, setPrivateStockCode] = useState("");
    const [privateStocks, setPrivateStocks] = useState(WATCHLIST.map((item) => item.code));
    const [customStockNames, setCustomStockNames] = useState({});
    const [rows, setRows] = useState([]);
    const [portfolioRows, setPortfolioRows] = useState([]);
    const [meta, setMeta] = useState(null);
    const [authLoading, setAuthLoading] = useState(false);
    const [authStep, setAuthStep] = useState("email");
    const [authForm, setAuthForm] = useState({ email: "", code: "" });
    const [authMessage, setAuthMessage] = useState("");
    const [watchlistSaving, setWatchlistSaving] = useState(false);
    const [loading, setLoading] = useState(false);
    const [portfolioLoading, setPortfolioLoading] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [alertSubmitting, setAlertSubmitting] = useState(false);
    const [lookupLoading, setLookupLoading] = useState(false);
    const [cancellingType, setCancellingType] = useState("");
    const [error, setError] = useState("");
    const [subscriptionMessage, setSubscriptionMessage] = useState("");
    const [alertMessage, setAlertMessage] = useState("");
    const [lookupMessage, setLookupMessage] = useState("");
    const [lookupResult, setLookupResult] = useState(null);
    const [authOpen, setAuthOpen] = useState(defaultPanelOpen);
    const [controlsOpen, setControlsOpen] = useState(true);
    const [subscriptionOpen, setSubscriptionOpen] = useState(defaultPanelOpen);
    const [alertOpen, setAlertOpen] = useState(defaultPanelOpen);
    const [lookupOpen, setLookupOpen] = useState(defaultPanelOpen);
    const [portfolioPinnedColumns, setPortfolioPinnedColumns] = useState(["stock"]);
    const [detailPinnedColumns, setDetailPinnedColumns] = useState(["date"]);
    const [portfolioSort, setPortfolioSort] = useState("zone_asc");
    const [portfolioView, setPortfolioView] = useState("table");
    const [customGroups, setCustomGroups] = useState(initCustomGroups);
    const [groupEditorOpen, setGroupEditorOpen] = useState(false);
    const [selectedGroupFilters, setSelectedGroupFilters] = useState([]);
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [presetCategory, setPresetCategory] = useState(WATCHLIST_SECTIONS[0].id);
    // —— 统一股票池 / 批量导入 ——
    const [importOpen, setImportOpen] = useState(false);
    const [poolSearch, setPoolSearch] = useState("");
    const [poolGroupFilter, setPoolGroupFilter] = useState("__all__");
    const [poolQuickOpen, setPoolQuickOpen] = useState(false);
    const [poolQuickErr, setPoolQuickErr] = useState(false);
    const [poolToast, setPoolToast] = useState("");
    const [fullscreenSection, setFullscreenSection] = useState(null);
    const dataRequestRef = useRef(0);
    const portfolioRequestRef = useRef(0);
    const filterAutoReloadReadyRef = useRef(false);
    const activeQueryKeyRef = useRef("");

    const activePeriod = coercePeriod(form.period);
    const computedRows = useMemo(() => computeBollingerBands(rows, activePeriod), [rows, activePeriod]);
    const displayRows = useMemo(
      () => computedRows.filter((row) => (!form.startDate || row.date >= form.startDate) && (!form.endDate || row.date <= form.endDate)),
      [computedRows, form.startDate, form.endDate]
    );
    const customGroupMap = useMemo(() => {
      const map = new Map();
      customGroups.forEach((group, groupIndex) => {
        (group.codes || []).forEach((code, codeOrder) => {
          if (!map.has(code)) map.set(code, { id: group.id, index: groupIndex, name: group.name, order: codeOrder });
        });
      });
      return map;
    }, [customGroups]);
    const sortedPortfolioRows = useMemo(() => {
      const withZone = portfolioRows.map((item) => ({
        ...item,
        zone: item.latest ? classifyCloseZone(item.latest.close, item.latest.middle, item.latest.bands) : null,
        customGroup: customGroupMap.get(item.code) || null,
      }));
      if (portfolioSort === "zone_asc" || portfolioSort === "zone_desc") {
        withZone.sort((a, b) => {
          const za = a.zone?.sortKey ?? 99;
          const zb = b.zone?.sortKey ?? 99;
          return portfolioSort === "zone_desc" ? zb - za : za - zb;
        });
      } else if (portfolioSort === "custom_group") {
        withZone.sort((a, b) => {
          const ga = a.customGroup?.index ?? 9999;
          const gb = b.customGroup?.index ?? 9999;
          if (ga !== gb) return ga - gb;
          const za = a.zone?.sortKey ?? 99;
          const zb = b.zone?.sortKey ?? 99;
          if (za !== zb) return za - zb;
          return (a.customGroup?.order ?? 9999) - (b.customGroup?.order ?? 9999);
        });
      } else if (portfolioSort === "price_band") {
        withZone.sort((a, b) => {
          const oa = classifyPriceBand(a.latest?.close).order;
          const ob = classifyPriceBand(b.latest?.close).order;
          if (oa !== ob) return oa - ob;
          return (b.latest?.close ?? 0) - (a.latest?.close ?? 0);
        });
      } else if (portfolioSort === "close_asc") {
        withZone.sort((a, b) => (a.latest?.close ?? 0) - (b.latest?.close ?? 0));
      } else if (portfolioSort === "close_desc") {
        withZone.sort((a, b) => (b.latest?.close ?? 0) - (a.latest?.close ?? 0));
      }
      return withZone;
    }, [portfolioRows, portfolioSort, customGroupMap]);
    const visiblePortfolioRows = useMemo(() => {
      if (portfolioSort !== "custom_group" || selectedGroupFilters.length === 0) return sortedPortfolioRows;
      const set = new Set(selectedGroupFilters);
      return sortedPortfolioRows.filter((item) => set.has(item.customGroup?.id ?? "__ungrouped__"));
    }, [sortedPortfolioRows, portfolioSort, selectedGroupFilters]);
    const latest = displayRows.filter((row) => row.middle !== null).at(-1);
    const previous = displayRows.filter((row) => row.middle !== null).at(-2);
    const middleDelta = latest && previous ? latest.middle - previous.middle : null;
    const chartRows = displayRows.filter((row) => row.middle !== null);
    const chartRangeLabel = chartRows.length
      ? `图像区间 ${chartRows[0].date} 至 ${chartRows.at(-1).date} · ${chartRows.length} 个交易日`
      : "图像区间等待足够交易日数据";

    function authHeaders() {
      return auth?.token ? { Authorization: `Bearer ${auth.token}` } : {};
    }

    function saveAuth(nextAuth) {
      setAuth(nextAuth);
      window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(nextAuth));
    }

    function clearAuthState(message = "已退出登录。") {
      setAuth(null);
      window.localStorage.removeItem(AUTH_STORAGE_KEY);
      setAuthStep("email");
      setAuthForm((current) => ({ email: current.email, code: "" }));
      const defaultCodes = WATCHLIST.map((item) => item.code);
      setSubscription((current) => ({ ...current, email: "", stocks: defaultCodes }));
      setAlertSubscription((current) => ({ ...current, email: "", stocks: defaultCodes }));
      setSubscriptionLookup({ email: "" });
      setLookupResult(null);
      setPrivateStocks(defaultCodes);
      setAuthMessage(message);
    }

    function applyUserState(payload, token = auth?.token) {
      const email = payload?.user?.email || payload?.email || auth?.email || "";
      if (!email || !token) return;
      saveAuth({ token, email });
      setAuthForm({ email, code: "" });
      rememberStockNames([...(payload.watchlist?.stocks || []), ...(payload.daily?.stocks || []), ...(payload.alert?.stocks || [])]);
      const watchlistCodes = payload.watchlist?.codes?.length ? payload.watchlist.codes : WATCHLIST.map((item) => item.code);
      // 统一选择集 = 每日订阅股票 ∪ 预警订阅股票（任一为空则回退到私有列表），避免重新提交前丢失任一侧的旧选择。
      const dailyCodes = payload.daily?.stocks?.length ? payload.daily.stocks.map((stock) => stock.code) : [];
      const alertCodes = payload.alert?.stocks?.length ? payload.alert.stocks.map((stock) => stock.code) : [];
      const unifiedSelection = [...new Set([...dailyCodes, ...alertCodes])];
      const selection = unifiedSelection.length ? unifiedSelection : watchlistCodes;
      // 股票池 = 私有列表 ∪ 选择集（保证所有被勾选的股票都在池中可见）
      setPrivateStocks([...new Set([...watchlistCodes, ...selection])]);
      setSubscription((current) => ({
        ...current,
        email,
        sendTime: payload.daily?.sendTime || current.sendTime,
        stocks: selection,
      }));
      setAlertSubscription((current) => ({
        ...current,
        email,
        stocks: selection,
        multiplier: payload.alert?.multiplier ? String(payload.alert.multiplier) : current.multiplier,
        condition: payload.alert?.condition || current.condition,
      }));
      setSubscriptionLookup({ email });
      setLookupResult({
        email,
        daily: payload.daily || null,
        alert: payload.alert || null,
        hasAny: Boolean(payload.daily || payload.alert),
        checkedAt: payload.checkedAt || new Date().toISOString(),
      });
    }

    function rememberStockNames(stocks) {
      const list = Array.isArray(stocks) ? stocks : [stocks];
      setCustomStockNames((current) => {
        const next = { ...current };
        let changed = false;
        list.forEach((stock) => {
          const code = String(stock?.code || "").trim();
          const name = String(stock?.name || "").trim();
          if (normalizeSecurityCode(code) && name && name !== code && next[code] !== name) {
            next[code] = name;
            changed = true;
          }
        });
        return changed ? next : current;
      });
    }

    async function refreshUserState(nextAuth = auth) {
      if (!nextAuth?.token) return;
      try {
        const response = await fetch(`${API_BASE}/api/me`, {
          headers: { Authorization: `Bearer ${nextAuth.token}` },
        });
        const payload = await response.json().catch(() => ({}));
        // 只有会话确实失效（401）才登出；网络抖动等临时错误不应清掉本地登录状态。
        if (response.status === 401) {
          clearAuthState(payload.error || "登录状态已失效，请重新登录。");
          return;
        }
        if (!response.ok) throw new Error(payload.error || "刷新账户状态失败。");
        applyUserState(payload, nextAuth.token);
      } catch (err) {
        setAuthMessage(err.message || "网络异常，暂时无法刷新账户状态。");
      }
    }

    async function requestLoginCode(event) {
      event.preventDefault();
      const email = authForm.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        setAuthMessage("请输入有效邮箱。");
        return;
      }

      setAuthLoading(true);
      setAuthMessage("");
      try {
        const response = await fetch(`${API_BASE}/api/auth/request-code`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "验证码发送失败。");
        setAuthForm({ email, code: "" });
        setAuthStep("code");
        setAuthMessage("验证码已发送，请查收邮件。");
      } catch (err) {
        setAuthMessage(err.message || "验证码发送失败，请稍后再试。");
      } finally {
        setAuthLoading(false);
      }
    }

    async function verifyLoginCode(event) {
      event.preventDefault();
      const email = authForm.email.trim().toLowerCase();
      const code = authForm.code.trim();
      if (!/^\d{6}$/.test(code)) {
        setAuthMessage("请输入 6 位验证码。");
        return;
      }

      setAuthLoading(true);
      setAuthMessage("");
      try {
        const response = await fetch(`${API_BASE}/api/auth/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, code }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "登录失败。");
        applyUserState(payload, payload.token);
        setAuthStep("email");
        setAuthMessage("登录成功，已加载你的私有列表和订阅记录。");
      } catch (err) {
        setAuthMessage(err.message || "登录失败，请检查验证码。");
      } finally {
        setAuthLoading(false);
      }
    }

    async function logout() {
      if (auth?.token) {
        fetch(`${API_BASE}/api/logout`, { method: "POST", headers: authHeaders() }).catch(() => {});
      }
      clearAuthState();
    }

    function addPrivateStock() {
      const code = normalizeSecurityCode(privateStockCode);
      if (!code) {
        setAuthMessage("\u8bf7\u8f93\u5165 A \u80a1/ETF\u3001\u6e2f\u80a1\u6216\u7f8e\u80a1\u4ee3\u7801\u540e\u518d\u6dfb\u52a0\u3002");
        return;
      }
      setPrivateStocks((current) => (current.includes(code) ? current : [...current, code]));
      setPrivateStockCode("");
      setAuthMessage("");
    }

    function removePrivateStock(code) {
      setPrivateStocks((current) => current.filter((item) => item !== code));
    }

    function applyPrivateStocksToForms() {
      if (privateStocks.length === 0) {
        setAuthMessage("私有列表至少需要一只股票。");
        return;
      }
      setSubscription((current) => ({ ...current, stocks: privateStocks }));
      setAlertSubscription((current) => ({ ...current, stocks: privateStocks }));
      setAuthMessage("已把私有列表应用到每日订阅和预警订阅。");
    }

    async function savePrivateWatchlist() {
      if (!auth?.token) {
        setAuthMessage("请先登录后再保存私有列表。");
        return;
      }
      if (privateStocks.length === 0) {
        setAuthMessage("私有列表至少需要一只股票。");
        return;
      }

      setWatchlistSaving(true);
      setAuthMessage("");
      try {
        const response = await fetch(`${API_BASE}/api/watchlist`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ codes: privateStocks }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "保存私有列表失败。");
        setPrivateStocks(payload.watchlist.codes);
        setAuthMessage("私有股票列表已保存。");
      } catch (err) {
        setAuthMessage(err.message || "保存私有列表失败，请稍后再试。");
      } finally {
        setWatchlistSaving(false);
      }
    }

    async function loadData(nextForm = form, force = false) {
      const nextQueryKey = queryKey(nextForm);
      // force：手动点“查询并计算”时即使参数没变也重新拉取（盘中刷新最新价）。
      if (!force && activeQueryKeyRef.current === nextQueryKey) return;
      activeQueryKeyRef.current = nextQueryKey;
      const requestId = ++dataRequestRef.current;
      const validationError = validateForm(nextForm);
      if (validationError) {
        activeQueryKeyRef.current = "";
        setError(validationError);
        return;
      }

      setLoading(true);
      setError("");
      try {
        const payload = await fetchKlines(nextForm);
        const parsedRows = payload.data.klines.map(parseKline);
        if (requestId !== dataRequestRef.current) return;
        setRows(parsedRows);
        setMeta({
          code: payload.data.code,
          name: resolveStockName(payload.data.code, payload.data.name),
          market: payload.data.market,
          count: parsedRows.length,
          source: payload.data.source,
          adjustFallback: Boolean(payload.data.adjustFallback),
          requestedAdjust: payload.data.requestedAdjust,
          realtime: payload.data.realtime || null,
        });
        rememberStockNames({ code: payload.data.code, name: payload.data.name });
      } catch (err) {
        if (requestId !== dataRequestRef.current) return;
        activeQueryKeyRef.current = "";
        setRows([]);
        setMeta(null);
        setError(err.message || "拉取行情失败。");
      } finally {
        if (requestId === dataRequestRef.current) setLoading(false);
      }
    }

    async function loadStockSummary(code, summaryBaseForm, period) {
      const summaryForm = { ...summaryBaseForm, code: normalizeSecurityCode(code), marketMode: "auto" };
      const payload = await fetchKlines(summaryForm);
      const stockRows = payload.data.klines.map(parseKline);
      const computed = computeBollingerBands(stockRows, period);
      const latestRow = computed
        .filter((row) => row.middle !== null && row.date >= summaryBaseForm.startDate && row.date <= summaryBaseForm.endDate)
        .at(-1);
      if (!latestRow) throw new Error(`日线数量不足以计算 ${period} 日布林带`);
      const displayName = resolveStockName(code, payload.data.name);
      rememberStockNames({ code, name: displayName });
      return {
        code,
        name: displayName,
        market: payload.data.market,
        latest: latestRow,
      };
    }

    async function loadPortfolio() {
      const requestId = ++portfolioRequestRef.current;
      if (subscription.stocks.length === 0) {
        setPortfolioRows([]);
        setPortfolioLoading(false);
        return;
      }
      const period = coercePeriod(form.period);
      if (!period) {
        setPortfolioRows(subscription.stocks.map((code) => ({ code, name: getStockLabel(code), error: periodError(form.period) })));
        setPortfolioLoading(false);
        return;
      }
      setPortfolioLoading(true);
      const summaryBaseForm = { ...form, period };
      const results = await mapWithConcurrency(
        subscription.stocks,
        4,
        async (code) => {
          try {
            return await loadStockSummary(code, summaryBaseForm, period);
          } catch (err) {
            return { code, name: getStockLabel(code), error: err.message || "加载失败" };
          }
        }
      );
      if (requestId !== portfolioRequestRef.current) return;
      setPortfolioRows(results);
      setPortfolioLoading(false);
    }

    async function submitSubscription(event) {
      event.preventDefault();
      const periodValidationError = periodError(form.period);
      if (periodValidationError) {
        setSubscriptionMessage(periodValidationError);
        return;
      }
      const validationError = validateSubscription(subscription, Boolean(auth?.token));
      if (validationError) {
        setSubscriptionMessage(validationError);
        return;
      }

      setSubmitting(true);
      setSubscriptionMessage("");
      try {
        const response = await fetch(`${API_BASE}/api/subscribe`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({
            email: auth?.email || subscription.email.trim(),
            sendTime: subscription.sendTime,
            stocks: subscription.stocks,
            period: coercePeriod(form.period),
            multipliers: BAND_MULTIPLIERS,
            timezone: "Asia/Shanghai",
          }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "订阅服务尚未启用。");
        setSubscriptionMessage("订阅成功，已发送确认邮件，之后会按所选时间每日推送。");
        refreshUserState();
      } catch (err) {
        setSubscriptionMessage(err.message || "订阅失败，请稍后再试。");
      } finally {
        setSubmitting(false);
      }
    }

    async function submitAlertSubscription(event) {
      event.preventDefault();
      const periodValidationError = periodError(form.period);
      if (periodValidationError) {
        setAlertMessage(periodValidationError);
        return;
      }
      const validationError = validateAlertSubscription(alertSubscription, Boolean(auth?.token));
      if (validationError) {
        setAlertMessage(validationError);
        return;
      }

      setAlertSubmitting(true);
      setAlertMessage("");
      try {
        const response = await fetch(`${API_BASE}/api/subscribe-alert`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({
            email: auth?.email || alertSubscription.email.trim(),
            stocks: alertSubscription.stocks,
            period: coercePeriod(form.period),
            multiplier: Number(alertSubscription.multiplier),
            condition: alertSubscription.condition,
            timezone: "Asia/Shanghai",
          }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "预警订阅服务尚未启用。");
        setAlertMessage("预警订阅成功，已发送确认邮件；触发条件后服务器会自动发送预警邮件。");
        refreshUserState();
      } catch (err) {
        setAlertMessage(err.message || "预警订阅失败，请稍后再试。");
      } finally {
        setAlertSubmitting(false);
      }
    }

    async function submitSubscriptionLookup(event) {
      event.preventDefault();
      if (!auth?.token) {
        setLookupMessage("请先登录后查看自己的订阅记录。");
        setAuthOpen(true);
        return;
      }

      setLookupLoading(true);
      setLookupMessage("");
      setLookupResult(null);
      try {
        const response = await fetch(`${API_BASE}/api/subscriptions`, {
          headers: authHeaders(),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "查询订阅失败。");
        setLookupResult(payload);
        setLookupMessage(payload.hasAny ? "已找到你的订阅配置。" : "当前账户暂未找到订阅配置。");
      } catch (err) {
        setLookupMessage(err.message || "查询订阅失败，请稍后再试。");
      } finally {
        setLookupLoading(false);
      }
    }

    async function cancelSubscription(type) {
      if (!auth?.token || !lookupResult?.email) return;
      const label = type === "daily" ? "每日汇总订阅" : "预警订阅";
      if (typeof window !== "undefined" && !window.confirm(`确认取消当前账户的${label}？`)) return;

      setCancellingType(type);
      setLookupMessage("");
      try {
        const response = await fetch(`${API_BASE}/api/unsubscribe`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ type }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "取消订阅失败。");
        setLookupResult(payload);
        setLookupMessage(`已取消${label}。`);
      } catch (err) {
        setLookupMessage(err.message || "取消订阅失败，请稍后再试。");
      } finally {
        setCancellingType("");
      }
    }

    useEffect(() => {
      loadData(createDefaultForm());
    }, []);

    useEffect(() => {
      if (!filterAutoReloadReadyRef.current) {
        filterAutoReloadReadyRef.current = true;
        return;
      }
      if (!isAutoReloadSecurityCode(form.code)) return;
      if (periodError(form.period) || validateForm(form)) return;

      const timer = window.setTimeout(() => {
        loadData(form);
      }, 450);
      return () => window.clearTimeout(timer);
    }, [form.code, form.marketMode, form.startDate, form.endDate, form.period, form.adjust]);

    useEffect(() => {
      if (auth?.token) {
        setAuthForm({ email: auth.email, code: "" });
        refreshUserState(auth);
      }
    }, []);

    useEffect(() => {
      loadPortfolio();
    }, [subscription.stocks.join(","), form.period, form.startDate, form.endDate, form.adjust]);

    useEffect(() => {
      if (!fullscreenSection) return;
      function onKey(e) { if (e.key === "Escape") setFullscreenSection(null); }
      document.addEventListener("keydown", onKey);
      return () => document.removeEventListener("keydown", onKey);
    }, [fullscreenSection]);

    useEffect(() => {
      try {
        window.localStorage.setItem(CUSTOM_GROUPS_STORAGE_KEY, JSON.stringify(customGroups));
      } catch {}
    }, [customGroups]);

    useEffect(() => {
      setSelectedGroupFilters((current) => current.filter((id) => id === "__ungrouped__" || customGroups.some((group) => group.id === id)));
    }, [customGroups]);

    useEffect(() => {
      if (!groupEditorOpen) return;
      function onKey(e) { if (e.key === "Escape") setGroupEditorOpen(false); }
      document.addEventListener("keydown", onKey);
      return () => document.removeEventListener("keydown", onKey);
    }, [groupEditorOpen]);

    useEffect(() => {
      if (!poolToast) return;
      const t = window.setTimeout(() => setPoolToast(""), 2600);
      return () => window.clearTimeout(t);
    }, [poolToast]);

    function addCustomGroup() {
      setCustomGroups((groups) => [...groups, { id: makeGroupId(groups), name: `分组 ${groups.length + 1}`, codes: [] }]);
    }

    function renameCustomGroup(id, name) {
      setCustomGroups((groups) => groups.map((group) => (group.id === id ? { ...group, name } : group)));
    }

    function deleteCustomGroup(id) {
      setCustomGroups((groups) => groups.filter((group) => group.id !== id));
    }

    function moveCustomGroup(id, direction) {
      setCustomGroups((groups) => {
        const index = groups.findIndex((group) => group.id === id);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= groups.length) return groups;
        const next = groups.slice();
        [next[index], next[target]] = [next[target], next[index]];
        return next;
      });
    }

    function assignStockToGroup(code, groupId) {
      setCustomGroups((groups) =>
        groups.map((group) => {
          if (group.id === groupId) {
            return group.codes.includes(code) ? group : { ...group, codes: [...group.codes, code] };
          }
          return group.codes.includes(code) ? { ...group, codes: group.codes.filter((item) => item !== code) } : group;
        })
      );
    }

    function removeStockFromGroup(code, groupId) {
      setCustomGroups((groups) => groups.map((group) => (group.id === groupId ? { ...group, codes: group.codes.filter((item) => item !== code) } : group)));
    }

    function toggleGroupFilter(id) {
      setSelectedGroupFilters((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
    }

    function updateField(key, value) {
      setForm((current) => ({ ...current, [key]: value }));
    }

    useEffect(() => {
      const normalized = normalizeSecurityCode(form.code) || form.code;
      const section = WATCHLIST_SECTIONS.find((item) => item.stocks.some((stock) => stock.code === normalized));
      if (section) setPresetCategory(section.id);
    }, [form.code]);

    function applyPreset(code) {
      setForm((current) => ({ ...current, code, marketMode: "auto" }));
    }

    function focusStock(code) {
      const nextForm = { ...form, code: normalizeSecurityCode(code), marketMode: "auto" };
      setForm(nextForm);
      loadData(nextForm);
    }

    // \u2014\u2014 \u7edf\u4e00\u9009\u62e9\u96c6\uff1a\u80a1\u7968\u6c60\u91cc\u52fe\u9009\u7684\u300c\u7eb3\u5165\u300d\u80a1\u7968\uff0c\u540c\u65f6\u9a71\u52a8\u6bcf\u65e5\u8ba2\u9605\u4e0e\u9884\u8b66\u8ba2\u9605 \u2014\u2014
    // subscription.stocks \u4e0e alertSubscription.stocks \u59cb\u7ec8\u4fdd\u6301\u4e00\u81f4\u3002
    function setSelection(next) {
      setSubscription((current) => ({ ...current, stocks: typeof next === "function" ? next(current.stocks) : next }));
      setAlertSubscription((current) => ({ ...current, stocks: typeof next === "function" ? next(current.stocks) : next }));
    }

    const poolFilteredCodes = useMemo(() => {
      const q = poolSearch.trim().toLowerCase();
      return privateStocks.filter((code) => {
        if (poolGroupFilter === "__ungrouped__") {
          if (customGroupMap.has(code)) return false;
        } else if (poolGroupFilter !== "__all__") {
          const group = customGroups.find((item) => item.id === poolGroupFilter);
          if (!group || !group.codes.includes(code)) return false;
        }
        if (!q) return true;
        const name = (lookupName(code) || customStockNames[code] || "").toLowerCase();
        return code.toLowerCase().includes(q) || name.includes(q);
      });
    }, [privateStocks, poolSearch, poolGroupFilter, customGroups, customGroupMap, customStockNames]);

    function toggleInclude(code) {
      setSelection((stocks) => (stocks.includes(code) ? stocks.filter((item) => item !== code) : [...stocks, code]));
    }
    function selectAllVisible() {
      setSelection((stocks) => { const set = new Set(stocks); poolFilteredCodes.forEach((c) => set.add(c)); return [...set]; });
    }
    function clearVisibleSelection() {
      setSelection((stocks) => { const hide = new Set(poolFilteredCodes); return stocks.filter((c) => !hide.has(c)); });
    }
    function invertVisibleSelection() {
      setSelection((stocks) => { const set = new Set(stocks); poolFilteredCodes.forEach((c) => (set.has(c) ? set.delete(c) : set.add(c))); return [...set]; });
    }

    function removeFromPool(code) {
      setPrivateStocks((cur) => cur.filter((item) => item !== code));
      setSelection((stocks) => stocks.filter((item) => item !== code));
      setCustomGroups((groups) => groups.map((group) => (group.codes.includes(code) ? { ...group, codes: group.codes.filter((item) => item !== code) } : group)));
    }

    function addPoolQuick() {
      const code = normalizeSecurityCode(privateStockCode);
      if (!code || privateStocks.includes(code)) { setPoolQuickErr(true); return; }
      setPrivateStocks((cur) => [...cur, code]);
      setSelection((stocks) => (stocks.includes(code) ? stocks : [...stocks, code]));
      setPrivateStockCode(""); setPoolQuickErr(false); setPoolQuickOpen(false);
      setPoolToast(`\u5df2\u6dfb\u52a0 ${lookupName(code) || code}`);
    }

    // \u5355\u5f52\u5c5e\u5206\u7ec4\uff1a\u9009\u67d0\u5206\u7ec4 \u2192 \u52a0\u5165\u5e76\u4ece\u5176\u5b83\u7ec4\u79fb\u9664\uff1b\u9009\u300c\u672a\u5206\u7ec4\u300d\u2192 \u4ece\u6240\u6709\u7ec4\u79fb\u9664
    function assignPoolGroup(code, groupId) {
      if (!groupId) {
        setCustomGroups((groups) => groups.map((group) => (group.codes.includes(code) ? { ...group, codes: group.codes.filter((item) => item !== code) } : group)));
      } else {
        assignStockToGroup(code, groupId);
      }
    }

    function handleImport({ items, groupChoice, newGroupName, autoInclude }) {
      const codes = items.map((it) => it.code);
      let targetGroupId = null;
      let label = "";
      if (groupChoice === "__new__" && newGroupName) {
        // 在函数式 updater 内基于最新 groups 生成 id，避免闭包里的旧 state 造成 id 冲突。
        setCustomGroups((groups) => [...groups, { id: makeGroupId(groups), name: newGroupName, codes: codes.slice() }]);
        label = newGroupName;
      } else if (groupChoice !== "__none__") {
        targetGroupId = groupChoice;
        label = (customGroups.find((g) => g.id === groupChoice) || {}).name || "";
        setCustomGroups((groups) => groups.map((group) => (group.id === targetGroupId ? { ...group, codes: [...new Set([...group.codes, ...codes])] } : group)));
      }
      const existing = new Set(privateStocks);
      const freshCount = codes.filter((c) => !existing.has(c)).length;
      setPrivateStocks((cur) => [...new Set([...cur, ...codes])]);
      rememberStockNames(items.filter((it) => it.name).map((it) => ({ code: it.code, name: it.name })));
      if (autoInclude) setSelection((stocks) => [...new Set([...stocks, ...codes])]);
      setImportOpen(false);
      setPoolToast(`\u5df2\u5bfc\u5165 ${freshCount} \u53ea\u80a1\u7968${label ? ` \u5230\u300c${label}\u300d` : ""}`);
    }

    // 本地已知的股票名称（自定义名库 ∪ 内置股票池）；查不到返回空串。
    function knownStockName(code) {
      const normalized = normalizeSecurityCode(code) || code;
      return customStockNames[normalized] || WATCHLIST.find((item) => item.code === normalized)?.name || "";
    }

    function getStockLabel(code) {
      const normalized = normalizeSecurityCode(code) || code;
      const name = knownStockName(code);
      return name ? `${name} ${normalized}` : `自定义 ${normalized}`;
    }

    // 行情源查不到名称时会把「名称」回退成代码本身，这里据此优先采用本地名库，
    // 避免「已选股票数据」表格 / 详情标题只显示代码而没有股票名。
    function resolveStockName(code, apiName) {
      const normalized = normalizeSecurityCode(code) || code;
      const trimmed = String(apiName || "").trim();
      const realApiName = trimmed && trimmed !== code && trimmed !== normalized ? trimmed : "";
      return realApiName || knownStockName(code) || realApiName;
    }

    function togglePortfolioPinnedColumn(key) {
      setPortfolioPinnedColumns((current) => togglePinnedColumn(PORTFOLIO_COLUMNS, current, key));
    }

    function portfolioGroupOf(item) {
      if (portfolioSort === "zone_asc" || portfolioSort === "zone_desc") {
        return {
          key: `z${item.zone?.sortKey ?? 99}`,
          label: item.zone ? item.zone.label : "无数据",
          cssClass: item.zone?.cssClass || "zone-none",
        };
      }
      if (portfolioSort === "custom_group") {
        if (item.customGroup) {
          return { key: `g${item.customGroup.index}`, label: item.customGroup.name, cssClass: "custom-group-head" };
        }
        return { key: "ungrouped", label: "未分组", cssClass: "zone-none" };
      }
      if (portfolioSort === "price_band") {
        const band = classifyPriceBand(item.latest?.close);
        return { key: band.key, label: band.label, cssClass: "price-band-head" };
      }
      return null;
    }

    function toggleDetailPinnedColumn(key) {
      setDetailPinnedColumns((current) => togglePinnedColumn(DETAIL_COLUMNS, current, key));
    }

    function renderGroupEditor() {
      if (!groupEditorOpen) return null;
      const availableCodes = privateStocks;
      return React.createElement(
        "div",
        { className: "group-editor-overlay", onClick: () => setGroupEditorOpen(false) },
        React.createElement(
          "div",
          { className: "group-editor", onClick: (event) => event.stopPropagation() },
          React.createElement(
            "div",
            { className: "group-editor-head" },
            React.createElement(
              "div",
              null,
              React.createElement("h3", null, "自定义分组"),
              React.createElement("p", { className: "group-editor-sub" }, "新建分组并把“已选股票数据”里的股票归类；在排序里选择“自定义分组”即可按此展示。")
            ),
            React.createElement("button", { type: "button", className: "group-editor-close", title: "关闭 (ESC)", onClick: () => setGroupEditorOpen(false) }, "×")
          ),
          React.createElement(
            "div",
            { className: "group-editor-body" },
            customGroups.length === 0
              ? React.createElement("div", { className: "group-empty" }, "还没有分组，点击下方“新建分组”开始。")
              : customGroups.map((group, groupIndex) =>
                  React.createElement(
                    "div",
                    { key: group.id, className: "group-card" },
                    React.createElement(
                      "div",
                      { className: "group-card-head" },
                      React.createElement("input", {
                        className: "group-name-input",
                        value: group.name,
                        maxLength: "20",
                        placeholder: "分组名称",
                        onChange: (event) => renameCustomGroup(group.id, event.target.value),
                      }),
                      React.createElement(
                        "div",
                        { className: "group-card-actions" },
                        React.createElement("button", { type: "button", className: "group-move", title: "上移", disabled: groupIndex === 0, onClick: () => moveCustomGroup(group.id, -1) }, "↑"),
                        React.createElement("button", { type: "button", className: "group-move", title: "下移", disabled: groupIndex === customGroups.length - 1, onClick: () => moveCustomGroup(group.id, 1) }, "↓"),
                        React.createElement("button", { type: "button", className: "group-delete", title: "删除分组", onClick: () => deleteCustomGroup(group.id) }, "删除")
                      )
                    ),
                    React.createElement(
                      "div",
                      { className: "group-stock-chips" },
                      group.codes.length === 0
                        ? React.createElement("span", { className: "group-stock-empty" }, "尚未添加股票")
                        : group.codes.map((code) =>
                            React.createElement(
                              "span",
                              { key: code, className: "group-stock-chip" },
                              getStockLabel(code),
                              React.createElement("button", { type: "button", className: "group-chip-remove", title: "移出分组", onClick: () => removeStockFromGroup(code, group.id) }, "×")
                            )
                          )
                    ),
                    React.createElement(
                      "select",
                      {
                        className: "group-add-select",
                        value: "",
                        onChange: (event) => { if (event.target.value) assignStockToGroup(event.target.value, group.id); },
                      },
                      React.createElement("option", { value: "" }, "+ 添加股票到该分组"),
                      availableCodes
                        .filter((code) => !group.codes.includes(code))
                        .map((code) => React.createElement("option", { key: code, value: code }, getStockLabel(code)))
                    )
                  )
                )
          ),
          React.createElement(
            "div",
            { className: "group-editor-foot" },
            React.createElement("button", { type: "button", className: "secondary-action", onClick: addCustomGroup }, "＋ 新建分组"),
            React.createElement("button", { type: "button", onClick: () => setGroupEditorOpen(false) }, "完成")
          )
        )
      );
    }

    function renderAuthPanel() {
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "button",
          {
            type: "button",
            className: "collapse-toggle auth-toggle",
            onClick: () => setAuthOpen((open) => !open),
            "aria-expanded": authOpen,
          },
          React.createElement("span", null, "账户"),
          React.createElement("strong", null, auth ? auth.email : "未登录也可订阅，登录可管理股票池"),
          React.createElement("span", { className: "toggle-state" }, authOpen ? "收起" : "展开")
        ),
        React.createElement(
          "div",
          { className: authOpen ? "collapsible-body" : "collapsible-body collapsed" },
          auth
            ? React.createElement(
                "div",
                { className: "subscription-panel auth-panel" },
                React.createElement(
                  "div",
                  { className: "auth-user-line" },
                  React.createElement("div", null, React.createElement("span", null, "当前账户"), React.createElement("strong", null, auth.email)),
                  React.createElement("button", { type: "button", className: "secondary-action", onClick: logout }, "退出")
                ),
                React.createElement("div", { className: "hint alert-hint" }, "股票池保存在服务器 KV 中；换设备登录同一邮箱后会自动加载。可在下方「我的股票池」管理与保存。"),
                authMessage && React.createElement("div", { className: authMessage.includes("成功") || authMessage.includes("已") ? "success" : "error compact" }, authMessage)
              )
            : React.createElement(
                "form",
                { className: "subscription-panel auth-panel", noValidate: true, onSubmit: authStep === "code" ? verifyLoginCode : requestLoginCode },
                React.createElement("label", null, "登录邮箱", React.createElement("input", { type: "email", value: authForm.email, placeholder: "name@example.com", onChange: (event) => setAuthForm((current) => ({ ...current, email: event.target.value })) })),
                authStep === "code" &&
                  React.createElement("label", null, "邮件验证码", React.createElement("input", { value: authForm.code, inputMode: "numeric", maxLength: "6", placeholder: "6 位验证码", onChange: (event) => setAuthForm((current) => ({ ...current, code: event.target.value.replace(/\D/g, "") })) })),
                React.createElement(
                  "div",
                  { className: "action-grid" },
                  React.createElement("button", { type: "submit", disabled: authLoading }, authLoading ? "处理中..." : authStep === "code" ? "登录" : "发送验证码"),
                  authStep === "code" && React.createElement("button", { type: "button", className: "secondary-action", disabled: authLoading, onClick: requestLoginCode }, "重发")
                ),
                React.createElement("div", { className: "hint alert-hint" }, "不登录也可以查询行情和提交订阅；之后用订阅邮箱登录，就能查看和取消这个邮箱自己的订阅记录。"),
                authMessage && React.createElement("div", { className: authMessage.includes("成功") || authMessage.includes("发送") ? "success" : "error compact" }, authMessage)
              )
        )
      );
    }

    function renderPoolPanel() {
      const includedSet = new Set(subscription.stocks);
      const includedCount = privateStocks.filter((c) => includedSet.has(c)).length;
      const groupCounts = {};
      let ungroupedCount = 0;
      privateStocks.forEach((code) => {
        const g = customGroupMap.get(code);
        if (g) groupCounts[g.id] = (groupCounts[g.id] || 0) + 1;
        else ungroupedCount += 1;
      });
      const visible = poolFilteredCodes;
      const allVisibleIncluded = visible.length > 0 && visible.every((c) => includedSet.has(c));
      let buckets;
      if (poolGroupFilter !== "__all__") {
        buckets = [{ id: poolGroupFilter, name: null, codes: visible }];
      } else {
        buckets = [];
        customGroups.forEach((g) => {
          const codes = visible.filter((c) => customGroupMap.get(c)?.id === g.id);
          if (codes.length) buckets.push({ id: g.id, name: g.name, codes });
        });
        const ungrouped = visible.filter((c) => !customGroupMap.has(c));
        if (ungrouped.length) buckets.push({ id: "__ungrouped__", name: "未分组", codes: ungrouped });
      }
      const nameOf = (code) => lookupName(code) || customStockNames[code] || "";

      return React.createElement(
        "div",
        { className: "pool-panel" },
        React.createElement(
          "div",
          { className: "pool-head" },
          React.createElement(
            "div",
            { className: "pool-title" },
            React.createElement("h3", null, "我的股票池"),
            React.createElement("span", { className: "pool-count" }, `${privateStocks.length} 只`)
          ),
          React.createElement(
            "div",
            { className: "pool-actions" },
            React.createElement(
              "button",
              { type: "button", className: "btn-import", onClick: () => setImportOpen(true) },
              React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.2", strokeLinecap: "round", strokeLinejoin: "round" }, React.createElement("path", { d: "M12 5v14M5 12h14" })),
              "批量导入"
            ),
            React.createElement("button", { type: "button", className: "btn-ghost", title: "快速添加单个", onClick: () => setPoolQuickOpen((o) => !o) }, "＋")
          )
        ),
        poolQuickOpen &&
          React.createElement(
            "div",
            { className: "custom-stock-row" },
            React.createElement("input", {
              value: privateStockCode,
              autoFocus: true,
              placeholder: "688256 / 00700 / AAPL",
              style: poolQuickErr ? { borderColor: "var(--danger)" } : null,
              onChange: (e) => { setPrivateStockCode(cleanSecurityInput(e.target.value)); setPoolQuickErr(false); },
              onKeyDown: (e) => { if (e.key === "Enter") addPoolQuick(); },
            }),
            React.createElement("button", { type: "button", onClick: addPoolQuick }, "添加")
          ),
        React.createElement(
          "div",
          { className: "pool-search" },
          React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" }, React.createElement("circle", { cx: "11", cy: "11", r: "7" }), React.createElement("path", { d: "m21 21-4.3-4.3" })),
          React.createElement("input", { value: poolSearch, placeholder: "搜索名称或代码…", onChange: (e) => setPoolSearch(e.target.value) })
        ),
        React.createElement(
          "div",
          { className: "pool-groups" },
          React.createElement("button", { type: "button", className: poolGroupFilter === "__all__" ? "pool-chip active" : "pool-chip", onClick: () => setPoolGroupFilter("__all__") }, "全部 ", React.createElement("span", { className: "ct" }, privateStocks.length)),
          customGroups.map((g) =>
            React.createElement("button", { key: g.id, type: "button", className: poolGroupFilter === g.id ? "pool-chip active" : "pool-chip", onClick: () => setPoolGroupFilter(g.id) }, g.name, " ", React.createElement("span", { className: "ct" }, groupCounts[g.id] || 0))
          ),
          ungroupedCount > 0 &&
            React.createElement("button", { type: "button", className: poolGroupFilter === "__ungrouped__" ? "pool-chip active" : "pool-chip", onClick: () => setPoolGroupFilter("__ungrouped__") }, "未分组 ", React.createElement("span", { className: "ct" }, ungroupedCount))
        ),
        React.createElement(
          "div",
          { className: "pool-selbar" },
          React.createElement("span", null, "已勾选 ", React.createElement("strong", null, includedCount), ` / ${privateStocks.length} 只纳入订阅`),
          React.createElement(
            "div",
            { className: "pool-selbar-actions" },
            React.createElement("button", { type: "button", className: "linkbtn", onClick: allVisibleIncluded ? clearVisibleSelection : selectAllVisible }, allVisibleIncluded ? "全不选" : "全选"),
            React.createElement("button", { type: "button", className: "linkbtn", onClick: invertVisibleSelection }, "反选")
          )
        ),
        React.createElement(
          "div",
          { className: "pool-list" },
          visible.length === 0
            ? React.createElement("div", { className: "pool-empty" }, "没有匹配的股票，试试调整搜索或分组筛选")
            : buckets.map((bucket) =>
                React.createElement(
                  React.Fragment,
                  { key: bucket.id || "single" },
                  bucket.name && React.createElement("div", { className: "pool-group-label" }, `${bucket.name} · ${bucket.codes.length}`),
                  bucket.codes.map((code) => {
                    const included = includedSet.has(code);
                    const curGroup = customGroupMap.get(code)?.id || "__none__";
                    const nm = nameOf(code);
                    return React.createElement(
                      "div",
                      { key: code, className: included ? "pool-row" : "pool-row excluded" },
                      React.createElement("input", { type: "checkbox", checked: included, onChange: () => toggleInclude(code), title: "纳入订阅 / 预警" }),
                      React.createElement(
                        "div",
                        { className: "pr-id" },
                        React.createElement("span", { className: "pr-name" }, nm || React.createElement("span", { className: "pending" }, "名称待获取")),
                        React.createElement(
                          "div",
                          { className: "pr-sub" },
                          React.createElement("span", { className: "pr-code" }, code),
                          React.createElement(MarketBadge, { code, market: marketCategory(code) })
                        )
                      ),
                      React.createElement(
                        "div",
                        { className: "pr-tools" },
                        React.createElement(
                          "select",
                          { className: "pr-group-select", value: curGroup, onChange: (e) => assignPoolGroup(code, e.target.value === "__none__" ? null : e.target.value), title: "所属分组" },
                          React.createElement("option", { value: "__none__" }, "未分组"),
                          customGroups.map((g) => React.createElement("option", { key: g.id, value: g.id }, g.name))
                        ),
                        React.createElement("button", { type: "button", className: "pr-remove", title: "移出股票池", onClick: () => removeFromPool(code) }, "×")
                      )
                    );
                  })
                )
              )
        ),
        auth &&
          React.createElement(
            "div",
            { className: "action-grid", style: { marginTop: "4px" } },
            React.createElement("button", { type: "button", onClick: savePrivateWatchlist, disabled: watchlistSaving }, watchlistSaving ? "保存中..." : "保存到服务器")
          )
      );
    }

    function renderBandGauge(item) {
      const lt = item.latest;
      if (!lt || !lt.standardDeviation || item.error) {
        return React.createElement("div", { className: "gauge gauge--empty" });
      }
      const sigma = (lt.close - lt.middle) / lt.standardDeviation;
      const pct = Math.max(3, Math.min(97, ((sigma + 3.5) / 7) * 100));
      return React.createElement(
        "div",
        { className: "gauge" },
        React.createElement(
          "div",
          { className: "gauge-track" },
          [-3, -2, -1, 1, 2, 3].map((t) =>
            React.createElement("span", { key: t, className: "gauge-tick", style: { left: `${((t + 3.5) / 7) * 100}%` } })
          ),
          React.createElement("span", { className: "gauge-mid", style: { left: "50%" } }),
          React.createElement("span", { className: "gauge-marker", style: { left: `${pct}%` }, title: `${sigma >= 0 ? "+" : ""}${sigma.toFixed(2)}σ` })
        ),
        React.createElement(
          "div",
          { className: "gauge-scale" },
          React.createElement("span", null, "\u22123\u03c3"),
          React.createElement("span", null, "中线"),
          React.createElement("span", null, "+3\u03c3")
        )
      );
    }

    function stockSigma(item) {
      const lt = item.latest;
      if (!lt || !lt.standardDeviation || item.error) return null;
      return (lt.close - lt.middle) / lt.standardDeviation;
    }

    function stockDisplayName(item) {
      return String(item.name || "").replace(item.code, "").trim() || item.code;
    }

    function renderStockCard(item) {
      const lt = item.latest;
      const sigma = stockSigma(item);
      return React.createElement(
        "button",
        { key: item.code, type: "button", className: form.code === item.code ? "pf-card active" : "pf-card", onClick: () => focusStock(item.code), disabled: Boolean(item.error) },
        React.createElement(
          "div",
          { className: "pf-card-top" },
          React.createElement(
            "div",
            { className: "pf-card-id" },
            React.createElement("span", { className: "pf-name" }, stockDisplayName(item)),
            React.createElement("span", { className: "pf-code" }, item.code)
          ),
          item.zone
            ? React.createElement("span", { className: `zone-chip ${item.zone.cssClass}` }, item.zone.label)
            : React.createElement("span", { className: "zone-chip zone-none" }, item.error ? "失败" : "--")
        ),
        item.error
          ? React.createElement("div", { className: "pf-err" }, item.error)
          : React.createElement(
              React.Fragment,
              null,
              React.createElement(
                "div",
                { className: "pf-card-price" },
                React.createElement("strong", null, formatNumber(lt.close)),
                sigma !== null && React.createElement("span", { className: "pf-sigma" }, `${sigma >= 0 ? "+" : ""}${sigma.toFixed(2)}\u03c3`)
              ),
              renderBandGauge(item),
              React.createElement(
                "div",
                { className: "pf-card-bands" },
                React.createElement("div", null, React.createElement("span", null, "中线"), React.createElement("b", null, formatNumber(lt.middle))),
                React.createElement("div", null, React.createElement("span", null, "±1\u03c3"), React.createElement("b", null, formatBandPair(lt.bands[1]))),
                React.createElement("div", null, React.createElement("span", null, "±2\u03c3"), React.createElement("b", null, formatBandPair(lt.bands[2])))
              )
            )
      );
    }

    function renderBoardTile(item) {
      const lt = item.latest;
      const sigma = stockSigma(item);
      return React.createElement(
        "button",
        { key: item.code, type: "button", className: form.code === item.code ? "board-tile active" : "board-tile", onClick: () => focusStock(item.code), disabled: Boolean(item.error) },
        React.createElement(
          "div",
          { className: "bt-top" },
          React.createElement("span", { className: "pf-name" }, stockDisplayName(item)),
          React.createElement("span", { className: "pf-code" }, item.code)
        ),
        React.createElement(
          "div",
          { className: "bt-mid" },
          React.createElement("strong", null, item.error ? "--" : formatNumber(lt.close)),
          sigma !== null && React.createElement("span", { className: "pf-sigma" }, `${sigma >= 0 ? "+" : ""}${sigma.toFixed(2)}\u03c3`)
        ),
        renderBandGauge(item)
      );
    }

    function renderPortfolioVisual() {
      const rows = visiblePortfolioRows;
      if (rows.length === 0) {
        return React.createElement("div", { className: "pf-empty" }, portfolioLoading ? "正在加载已选股票…" : "暂无已选股票");
      }
      if (portfolioView === "cards") {
        return React.createElement("div", { className: "pf-scroll" }, React.createElement("div", { className: "pf-cards" }, rows.map(renderStockCard)));
      }
      const buckets = new Map();
      rows.forEach((item) => {
        const key = item.zone ? item.zone.sortKey : 99;
        if (!buckets.has(key)) buckets.set(key, { zone: item.zone, items: [] });
        buckets.get(key).items.push(item);
      });
      const sortedBuckets = [...buckets.values()].sort((a, b) => (a.zone?.sortKey ?? 99) - (b.zone?.sortKey ?? 99));
      return React.createElement(
        "div",
        { className: "pf-scroll" },
        React.createElement(
          "div",
          { className: "pf-board" },
          sortedBuckets.map((bucket, i) =>
            React.createElement(
              "div",
              { key: i, className: "board-col" },
              React.createElement("div", { className: `board-col-head ${bucket.zone ? bucket.zone.cssClass : "zone-none"}` }, `${bucket.zone ? bucket.zone.label : "无数据"} · ${bucket.items.length} 只`),
              React.createElement("div", { className: "board-tiles" }, bucket.items.map(renderBoardTile))
            )
          )
        )
      );
    }

    return React.createElement(
      "main",
      { className: "shell" },
      React.createElement(QueryStatus, { loading, portfolioLoading, stockLabel: getStockLabel(form.code), stockCount: subscription.stocks.length, floating: true }),
      renderGroupEditor(),
      React.createElement(ImportModal, { open: importOpen, onClose: () => setImportOpen(false), poolCodes: privateStocks, groups: customGroups, onImport: handleImport }),
      poolToast && React.createElement("div", { className: "pool-toast" }, React.createElement("span", { className: "dot" }), poolToast),
      React.createElement(
        "section",
        { className: sidebarOpen ? "workspace" : "workspace workspace--sidebar-collapsed" },
        React.createElement(
          "aside",
          { className: sidebarOpen ? "control-panel" : "control-panel control-panel--collapsed" },
          React.createElement(
            "button",
            { type: "button", className: "sidebar-toggle-btn", onClick: () => setSidebarOpen((o) => !o), title: sidebarOpen ? "收起侧栏" : "展开侧栏" },
            sidebarOpen ? "«" : "»"
          ),
          React.createElement(
            "div",
            { className: "sidebar-body" },
            React.createElement("div", { className: "brand" }, React.createElement("span", null, "BB"), React.createElement("div", null, React.createElement("h1", null, "日布林带"), React.createElement("p", null, "中线与 1/2/3 倍标准差轨道"))),
            renderAuthPanel(),
            renderPoolPanel(),
            React.createElement(
              "button",
              {
                type: "button",
                className: "collapse-toggle",
                onClick: () => setControlsOpen((open) => !open),
                "aria-expanded": controlsOpen,
              },
              React.createElement("span", null, "参数设置"),
            React.createElement("strong", null, `${getStockLabel(form.code)} · N=${form.period}`),
            React.createElement("span", { className: "toggle-state" }, controlsOpen ? "收起" : "展开")
          ),
          React.createElement(
            "div",
            { className: controlsOpen ? "collapsible-body" : "collapsible-body collapsed" },
            React.createElement(
              "form",
              {
                onSubmit: (event) => {
                  event.preventDefault();
                  loadData(form, true);
                },
              },
              React.createElement("label", null, "股票代码", React.createElement("input", { value: form.code, inputMode: "text", maxLength: "12", placeholder: "688256 / 00700 / AAPL", onChange: (event) => updateField("code", cleanSecurityInput(event.target.value)) })),
              React.createElement(
                "div",
                { className: "preset-tabs" },
                WATCHLIST_SECTIONS.map((section) =>
                  React.createElement(
                    "button",
                    { key: section.id, type: "button", className: presetCategory === section.id ? "preset-tab active" : "preset-tab", onClick: () => setPresetCategory(section.id) },
                    section.label
                  )
                )
              ),
              React.createElement(
                "div",
                { className: "preset-row" },
                (WATCHLIST_SECTIONS.find((section) => section.id === presetCategory) || WATCHLIST_SECTIONS[0]).stocks.map((stock) =>
                  React.createElement(
                    "button",
                    { key: stock.code, type: "button", className: form.code === stock.code ? "preset active" : "preset", onClick: () => applyPreset(stock.code), title: `${stock.name} ${stock.code}` },
                    stock.name
                  )
                )
              ),
              React.createElement(
                "label",
                null,
                "市场",
                React.createElement(
                  "select",
                  { value: form.marketMode, onChange: (event) => updateField("marketMode", event.target.value) },
                  React.createElement("option", { value: "auto" }, "自动识别"),
                  React.createElement("option", { value: "1" }, "沪市 / 科创板"),
                  React.createElement("option", { value: "0" }, "深市 / 北交所"),
                  React.createElement("option", { value: "116" }, "港股"),
                  React.createElement("option", { value: "US" }, "\u7f8e\u80a1")
                )
              ),
              React.createElement(
                "div",
                { className: "date-grid" },
                React.createElement("label", null, "开始日期", React.createElement("input", { type: "date", value: form.startDate, onChange: (event) => updateField("startDate", event.target.value) })),
                React.createElement("label", null, "结束日期", React.createElement("input", { type: "date", value: form.endDate, onChange: (event) => updateField("endDate", event.target.value) }))
              ),
              React.createElement(
                "div",
                { className: "date-grid" },
                React.createElement("label", null, "周期 N", React.createElement("input", { type: "number", min: "2", max: "250", step: "1", value: form.period, onChange: (event) => updateField("period", event.target.value.replace(/\D/g, "")) })),
                React.createElement(
                  "label",
                  null,
                  "复权",
                  React.createElement(
                    "select",
                    { value: form.adjust, onChange: (event) => updateField("adjust", event.target.value) },
                    React.createElement("option", { value: "1" }, "前复权"),
                    React.createElement("option", { value: "3" }, "等比前复权"),
                    React.createElement("option", { value: "0" }, "不复权"),
                    React.createElement("option", { value: "2" }, "后复权")
                  )
                )
              ),
              React.createElement("button", { type: "submit", disabled: loading }, loading ? "查询中..." : "查询并计算")
            ),
            React.createElement("div", { className: "hint" }, `开始/结束日期会筛选图表、明细和区间内最新行；结束日期落在非交易日时使用此前最近交易日。收盘价不随 N 变化，N 只影响中线、标准差和上下轨。当前复权：${ADJUST_LABELS[form.adjust]}。`),
            meta?.adjustFallback &&
              React.createElement("div", { className: "warning compact" }, `当前行情源未返回${ADJUST_LABELS[meta.requestedAdjust] || "所选"}数据，已临时使用不复权日线。`),
            error && React.createElement("div", { className: "error" }, error)
          ),
          React.createElement(
            "button",
            {
              type: "button",
              className: "collapse-toggle subscription-toggle",
              onClick: () => setSubscriptionOpen((open) => !open),
              "aria-expanded": subscriptionOpen,
            },
            React.createElement("span", null, "邮件订阅"),
            React.createElement("strong", null, `${subscription.stocks.length} 只股票 · ${subscription.sendTime}`),
            React.createElement("span", { className: "toggle-state" }, subscriptionOpen ? "收起" : "展开")
          ),
          React.createElement(
            "div",
            { className: subscriptionOpen ? "collapsible-body" : "collapsible-body collapsed" },
            React.createElement(
              "form",
              { className: "subscription-panel", noValidate: true, onSubmit: submitSubscription },
              React.createElement("label", null, auth ? "接收邮箱（登录账户）" : "接收邮箱", React.createElement("input", { type: "email", value: auth?.email || subscription.email, placeholder: "name@example.com", readOnly: Boolean(auth), onChange: (event) => setSubscription((current) => ({ ...current, email: event.target.value })) })),
              React.createElement("label", null, "每天推送时间", React.createElement("input", { type: "time", value: subscription.sendTime, onChange: (event) => setSubscription((current) => ({ ...current, sendTime: event.target.value })) })),
              React.createElement("div", { className: "hint alert-hint" }, "已自动选用「我的股票池」中勾选的 ", React.createElement("strong", null, subscription.stocks.length), " 只股票，无需在此重复维护列表。"),
              React.createElement("button", { type: "submit", disabled: submitting }, submitting ? "提交中..." : "订阅每日邮件"),
              subscriptionMessage && React.createElement("div", { className: subscriptionMessage.includes("成功") ? "success" : "error compact" }, subscriptionMessage)
            )
          ),
          React.createElement(
            "button",
            {
              type: "button",
              className: "collapse-toggle alert-toggle",
              onClick: () => setAlertOpen((open) => !open),
              "aria-expanded": alertOpen,
            },
            React.createElement("span", null, "预警订阅"),
            React.createElement("strong", null, `${alertSubscription.stocks.length} 只股票 · ±${alertSubscription.multiplier}σ · ${ALERT_CONDITION_LABELS[alertSubscription.condition]}`),
            React.createElement("span", { className: "toggle-state" }, alertOpen ? "收起" : "展开")
          ),
          React.createElement(
            "div",
            { className: alertOpen ? "collapsible-body" : "collapsible-body collapsed" },
            React.createElement(
              "form",
              { className: "subscription-panel alert-panel", noValidate: true, onSubmit: submitAlertSubscription },
              React.createElement("label", null, auth ? "预警邮箱（登录账户）" : "预警邮箱", React.createElement("input", { type: "email", value: auth?.email || alertSubscription.email, placeholder: "name@example.com", readOnly: Boolean(auth), onChange: (event) => setAlertSubscription((current) => ({ ...current, email: event.target.value })) })),
              React.createElement(
                "div",
                { className: "date-grid" },
                React.createElement(
                  "label",
                  null,
                  "轨道倍数",
                  React.createElement(
                    "select",
                    { value: alertSubscription.multiplier, onChange: (event) => setAlertSubscription((current) => ({ ...current, multiplier: event.target.value })) },
                    React.createElement("option", { value: "1" }, "±1σ"),
                    React.createElement("option", { value: "2" }, "±2σ"),
                    React.createElement("option", { value: "3" }, "±3σ")
                  )
                ),
                React.createElement(
                  "label",
                  null,
                  "触发条件",
                  React.createElement(
                    "select",
                    { value: alertSubscription.condition, onChange: (event) => setAlertSubscription((current) => ({ ...current, condition: event.target.value })) },
                    React.createElement("option", { value: "outside" }, ALERT_CONDITION_LABELS.outside),
                    React.createElement("option", { value: "above" }, ALERT_CONDITION_LABELS.above),
                    React.createElement("option", { value: "below" }, ALERT_CONDITION_LABELS.below)
                  )
                )
              ),
              React.createElement("div", { className: "hint alert-hint" }, "监控「我的股票池」中勾选的 ", React.createElement("strong", null, alertSubscription.stocks.length), ` 只股票。服务器每分钟检查一次；同一邮箱、同一股票、同一规则、同一交易日只发送一次预警。当前周期 N=${form.period}。`),
              React.createElement("button", { type: "submit", disabled: alertSubmitting }, alertSubmitting ? "提交中..." : "订阅预警邮件"),
              alertMessage && React.createElement("div", { className: alertMessage.includes("成功") ? "success" : "error compact" }, alertMessage)
            )
          ),
          React.createElement(
            "button",
            {
              type: "button",
              className: "collapse-toggle lookup-toggle",
              onClick: () => setLookupOpen((open) => !open),
              "aria-expanded": lookupOpen,
            },
            React.createElement("span", null, "订阅查询"),
            React.createElement("strong", null, auth ? `${auth.email} 的订阅记录` : "登录后查看自己的订阅"),
            React.createElement("span", { className: "toggle-state" }, lookupOpen ? "收起" : "展开")
          ),
          React.createElement(
            "div",
            { className: lookupOpen ? "collapsible-body" : "collapsible-body collapsed" },
            React.createElement(
              "form",
              { className: "subscription-panel lookup-panel", noValidate: true, onSubmit: submitSubscriptionLookup },
              React.createElement("div", { className: "hint alert-hint" }, auth ? `当前只查询 ${auth.email} 的服务器订阅记录。` : "请先登录，登录后才能查看和取消自己的订阅。"),
              auth
                ? React.createElement("button", { type: "submit", disabled: lookupLoading }, lookupLoading ? "查询中..." : "刷新我的订阅")
                : React.createElement("button", { type: "button", onClick: () => setAuthOpen(true) }, "去登录"),
              lookupMessage && React.createElement("div", { className: lookupMessage.includes("已找到") || lookupMessage.includes("已取消") || lookupMessage.includes("暂未找到") ? "success" : "error compact" }, lookupMessage),
              lookupResult &&
                React.createElement(
                  "div",
                  { className: "subscription-result" },
                  React.createElement(SubscriptionStatusCard, { type: "daily", data: lookupResult.daily, onCancel: cancelSubscription, cancellingType }),
                  React.createElement(SubscriptionStatusCard, { type: "alert", data: lookupResult.alert, onCancel: cancelSubscription, cancellingType })
                )
            )
          )
        )
        ),
        React.createElement(
          "section",
          { className: "content" },
          React.createElement(
            "header",
            { className: "summary" },
            React.createElement(
              "div",
              null,
              React.createElement("p", { className: "eyebrow" }, meta ? `${meta.name ? meta.name + " " : ""}${meta.code} · ${marketLabel(meta.market)}${meta.source === "demo" ? " · 示例数据" : ""}` : "等待行情"),
              React.createElement("h2", null, meta ? `${meta.name ? meta.name + " " : ""}${meta.code}` : "日布林带计算器"),
              React.createElement(
                "span",
                null,
                latest
                  ? (meta?.realtime && latest.date === meta.realtime.date
                      ? `${latest.date} 最新价 ${formatNumber(latest.close)}${formatQuoteTime(meta.realtime.time) ? ` · 行情 ${formatQuoteTime(meta.realtime.time)}` : ""}（不随 N 变化）`
                      : `${latest.date} 最新收盘价 ${formatNumber(latest.close)}（不随 N 变化）`)
                  : "输入参数后获取日线数据"
              )
            )
          ),
          meta?.adjustFallback &&
            React.createElement("div", { className: "warning" }, `当前行情源未返回${ADJUST_LABELS[meta.requestedAdjust] || "所选"}数据，已临时使用不复权日线。`),
          React.createElement(
            "section",
            { className: [portfolioLoading ? "table-panel portfolio-panel is-loading" : "table-panel portfolio-panel", fullscreenSection === "portfolio" ? "panel-fullscreen" : ""].filter(Boolean).join(" ") },
            React.createElement(
              "div",
              { className: "table-head" },
              React.createElement("h3", null, "已选股票数据"),
              React.createElement(
                "div",
                { className: "table-meta" },
                React.createElement(
                  "div",
                  { className: "view-switch" },
                  React.createElement("button", { type: "button", className: portfolioView === "board" ? "vs-btn active" : "vs-btn", onClick: () => setPortfolioView("board") }, "看板"),
                  React.createElement("button", { type: "button", className: portfolioView === "cards" ? "vs-btn active" : "vs-btn", onClick: () => setPortfolioView("cards") }, "卡片"),
                  React.createElement("button", { type: "button", className: portfolioView === "table" ? "vs-btn active" : "vs-btn", onClick: () => setPortfolioView("table") }, "表格")
                ),
                React.createElement(
                  "select",
                  { className: "sort-select", value: portfolioSort, onChange: (event) => setPortfolioSort(event.target.value) },
                  React.createElement("option", { value: "zone_asc" }, "区间排序（上→下）"),
                  React.createElement("option", { value: "zone_desc" }, "区间排序（下→上）"),
                  React.createElement("option", { value: "custom_group" }, "自定义分组"),
                  React.createElement("option", { value: "price_band" }, "按收盘价区间分组"),
                  React.createElement("option", { value: "close_desc" }, "收盘价（高→低）"),
                  React.createElement("option", { value: "close_asc" }, "收盘价（低→高）"),
                  React.createElement("option", { value: "default" }, "默认顺序")
                ),
                React.createElement("button", { type: "button", className: "group-edit-btn", title: "自定义分组管理", onClick: () => { setPortfolioSort("custom_group"); setGroupEditorOpen(true); } }, "编辑分组"),
                React.createElement("span", null, portfolioLoading ? "更新中..." : "点击查看图像"),
                portfolioView === "table" && React.createElement(ColumnPinControls, { columns: PORTFOLIO_COLUMNS, pinnedColumns: portfolioPinnedColumns, onToggle: togglePortfolioPinnedColumn }),
                React.createElement("button", { type: "button", className: "fullscreen-btn", title: fullscreenSection === "portfolio" ? "退出全屏 (ESC)" : "全屏展示", onClick: () => setFullscreenSection((s) => s === "portfolio" ? null : "portfolio") }, fullscreenSection === "portfolio" ? "还原" : "全屏")
              )
            ),
            portfolioSort === "custom_group" && customGroups.length > 0 &&
              React.createElement(
                "div",
                { className: "group-filter-bar" },
                React.createElement("button", { type: "button", className: selectedGroupFilters.length === 0 ? "group-filter-chip active" : "group-filter-chip", onClick: () => setSelectedGroupFilters([]) }, "全部"),
                customGroups.map((group) =>
                  React.createElement(
                    "button",
                    { key: group.id, type: "button", className: selectedGroupFilters.includes(group.id) ? "group-filter-chip active" : "group-filter-chip", onClick: () => toggleGroupFilter(group.id) },
                    `${group.name} (${group.codes.length})`
                  )
                ),
                sortedPortfolioRows.some((item) => !item.customGroup) &&
                  React.createElement("button", { type: "button", className: selectedGroupFilters.includes("__ungrouped__") ? "group-filter-chip active" : "group-filter-chip", onClick: () => toggleGroupFilter("__ungrouped__") }, "未分组")
              ),
            portfolioView !== "table" ? renderPortfolioVisual() : React.createElement(
              "div",
              { className: "table-wrap" },
              React.createElement(
                "table",
                { className: "portfolio-table pin-table", style: { minWidth: `${tableMinWidth(PORTFOLIO_COLUMNS)}px` } },
                React.createElement("colgroup", null, PORTFOLIO_COLUMNS.map((column) => React.createElement("col", { key: column.key, style: { width: `${column.width}px` } }))),
                React.createElement(
                  "thead",
                  null,
                  React.createElement("tr", null, PORTFOLIO_COLUMNS.map((column) => React.createElement("th", { key: column.key, ...cellProps(PORTFOLIO_COLUMNS, portfolioPinnedColumns, column.key) }, column.label)))
                ),
                React.createElement(
                  "tbody",
                  null,
                  visiblePortfolioRows.flatMap((item, idx) => {
                    const group = portfolioGroupOf(item);
                    const prevItem = idx > 0 ? visiblePortfolioRows[idx - 1] : null;
                    const prevGroup = prevItem ? portfolioGroupOf(prevItem) : null;
                    const showGroup = Boolean(group) && (idx === 0 || group.key !== prevGroup?.key);
                    const elements = [];
                    if (showGroup) {
                      let count = 0;
                      for (let i = idx; i < visiblePortfolioRows.length && portfolioGroupOf(visiblePortfolioRows[i])?.key === group.key; i++) count++;
                      elements.push(
                        React.createElement("tr", { key: `group-${idx}` },
                          React.createElement("td", { colSpan: PORTFOLIO_COLUMNS.length, className: `zone-group-cell ${group.cssClass}` },
                            `${group.label}  ·  ${count} 只`
                          )
                        )
                      );
                    }
                    elements.push(
                      React.createElement(
                        "tr",
                        { key: item.code, className: form.code === item.code ? "active-row" : "" },
                        React.createElement("td", cellProps(PORTFOLIO_COLUMNS, portfolioPinnedColumns, "stock"),
                          React.createElement("div", { className: "stock-cell" },
                            React.createElement("span", { className: "stock-name" }, String(item.name || "").replace(item.code, "").trim() || item.code),
                            React.createElement("span", { className: "stock-code" }, item.code)
                          )
                        ),
                        React.createElement("td", cellProps(PORTFOLIO_COLUMNS, portfolioPinnedColumns, "date"), item.error ? item.error : formatShortDate(item.latest.date)),
                        React.createElement("td", cellProps(PORTFOLIO_COLUMNS, portfolioPinnedColumns, "close"), item.error ? "--" : formatNumber(item.latest.close)),
                        React.createElement("td", cellProps(PORTFOLIO_COLUMNS, portfolioPinnedColumns, "zone"),
                          item.zone ? React.createElement("span", { className: `zone-chip ${item.zone.cssClass}` }, item.zone.label) : "--"
                        ),
                        React.createElement("td", cellProps(PORTFOLIO_COLUMNS, portfolioPinnedColumns, "middle", "middle-cell"), item.error ? "--" : formatNumber(item.latest.middle)),
                        React.createElement("td", cellProps(PORTFOLIO_COLUMNS, portfolioPinnedColumns, "stddev"), item.error ? "--" : formatNumber(item.latest.standardDeviation)),
                        React.createElement("td", cellProps(PORTFOLIO_COLUMNS, portfolioPinnedColumns, "k1"), item.error ? "--" : formatBandPair(item.latest.bands[1])),
                        React.createElement("td", cellProps(PORTFOLIO_COLUMNS, portfolioPinnedColumns, "k2"), item.error ? "--" : formatBandPair(item.latest.bands[2])),
                        React.createElement("td", cellProps(PORTFOLIO_COLUMNS, portfolioPinnedColumns, "k3"), item.error ? "--" : formatBandPair(item.latest.bands[3])),
                        React.createElement("td", cellProps(PORTFOLIO_COLUMNS, portfolioPinnedColumns, "chart"), React.createElement("button", { type: "button", className: "table-action", onClick: () => focusStock(item.code), disabled: Boolean(item.error) }, "查看"))
                      )
                    );
                    return elements;
                  })
                )
              )
            )
          ),
          React.createElement(
            "section",
            { className: fullscreenSection === "stats" ? "stats-row-wrap panel-fullscreen" : "stats-row-wrap" },
            React.createElement(
              "div",
              { className: "stats-row-head" },
              React.createElement("span", { className: "stats-row-title" }, "布林带统计"),
              React.createElement("button", { type: "button", className: "fullscreen-btn", title: fullscreenSection === "stats" ? "退出全屏 (ESC)" : "全屏展示", onClick: () => setFullscreenSection((s) => s === "stats" ? null : "stats") }, fullscreenSection === "stats" ? "还原" : "全屏")
            ),
            React.createElement(
              "div",
              { className: "stats-row" },
              React.createElement(Stat, { label: `${form.period} 日中线`, value: latest ? formatNumber(latest.middle) : "--" }),
              React.createElement(Stat, { label: "标准差", value: latest ? formatNumber(latest.standardDeviation) : "--" }),
              React.createElement(Stat, { label: "K=1 上/下", value: latest ? `${formatNumber(latest.bands[1].upper)} / ${formatNumber(latest.bands[1].lower)}` : "--" }),
              React.createElement(Stat, { label: "K=2 上/下", value: latest ? `${formatNumber(latest.bands[2].upper)} / ${formatNumber(latest.bands[2].lower)}` : "--" }),
              React.createElement(Stat, { label: "K=3 上/下", value: latest ? `${formatNumber(latest.bands[3].upper)} / ${formatNumber(latest.bands[3].lower)}` : "--" }),
              React.createElement(Stat, { label: "中线日变动", value: middleDelta === null ? "--" : `${middleDelta >= 0 ? "+" : ""}${formatNumber(middleDelta)}`, tone: middleDelta === null ? "" : middleDelta >= 0 ? "up" : "down" })
            )
          ),
          React.createElement(
            "section",
            { className: [loading ? "chart-panel is-loading" : "chart-panel", fullscreenSection === "chart" ? "panel-fullscreen" : ""].filter(Boolean).join(" ") },
            React.createElement(
              "div",
              { className: "chart-caption" },
              chartRangeLabel,
              React.createElement("button", { type: "button", className: "fullscreen-btn chart-fullscreen-btn", title: fullscreenSection === "chart" ? "退出全屏 (ESC)" : "全屏展示", onClick: () => setFullscreenSection((s) => s === "chart" ? null : "chart") }, fullscreenSection === "chart" ? "还原" : "全屏")
            ),
            React.createElement(MiniChart, { rows: displayRows }),
            React.createElement(
              "div",
              { className: "legend chart-legend" },
              React.createElement("span", { className: "legend-price" }, "收盘价"),
              React.createElement("span", { className: "legend-middle" }, "中线"),
              React.createElement("span", { className: "legend-band1" }, "±1σ"),
              React.createElement("span", { className: "legend-band2" }, "±2σ"),
              React.createElement("span", { className: "legend-band3" }, "±3σ")
            )
          ),
          React.createElement(
            "section",
            { className: fullscreenSection === "detail" ? "table-panel panel-fullscreen" : "table-panel" },
            React.createElement(
              "div",
              { className: "table-head" },
              React.createElement("h3", null, "计算明细"),
              React.createElement(
                "div",
                { className: "table-meta" },
                React.createElement("span", null, "按交易日倒序"),
                React.createElement(ColumnPinControls, { columns: DETAIL_COLUMNS, pinnedColumns: detailPinnedColumns, onToggle: toggleDetailPinnedColumn }),
                React.createElement("button", { type: "button", className: "fullscreen-btn", title: fullscreenSection === "detail" ? "退出全屏 (ESC)" : "全屏展示", onClick: () => setFullscreenSection((s) => s === "detail" ? null : "detail") }, fullscreenSection === "detail" ? "还原" : "全屏")
              )
            ),
            React.createElement(
              "div",
              { className: "table-wrap" },
              React.createElement(
                "table",
                { className: "pin-table", style: { minWidth: `${tableMinWidth(DETAIL_COLUMNS)}px` } },
                React.createElement("colgroup", null, DETAIL_COLUMNS.map((column) => React.createElement("col", { key: column.key, style: { width: `${column.width}px` } }))),
                React.createElement(
                  "thead",
                  null,
                  React.createElement("tr", null, DETAIL_COLUMNS.map((column) => React.createElement("th", { key: column.key, ...cellProps(DETAIL_COLUMNS, detailPinnedColumns, column.key) }, column.label)))
                ),
                React.createElement(
                  "tbody",
                  null,
                  displayRows
                    .slice()
                    .reverse()
                    .map((row) =>
                      React.createElement(
                        "tr",
                        { key: row.date },
                        React.createElement("td", cellProps(DETAIL_COLUMNS, detailPinnedColumns, "date"), formatShortDate(row.date)),
                        React.createElement("td", cellProps(DETAIL_COLUMNS, detailPinnedColumns, "close"), formatNumber(row.close)),
                        React.createElement("td", cellProps(DETAIL_COLUMNS, detailPinnedColumns, "middle", "middle-cell"), formatNumber(row.middle)),
                        React.createElement("td", cellProps(DETAIL_COLUMNS, detailPinnedColumns, "stddev"), formatNumber(row.standardDeviation)),
                        React.createElement("td", cellProps(DETAIL_COLUMNS, detailPinnedColumns, "k1Upper", "upper-cell"), formatNumber(row.bands[1]?.upper)),
                        React.createElement("td", cellProps(DETAIL_COLUMNS, detailPinnedColumns, "k1Lower", "lower-cell"), formatNumber(row.bands[1]?.lower)),
                        React.createElement("td", cellProps(DETAIL_COLUMNS, detailPinnedColumns, "k2Upper", "upper-cell"), formatNumber(row.bands[2]?.upper)),
                        React.createElement("td", cellProps(DETAIL_COLUMNS, detailPinnedColumns, "k2Lower", "lower-cell"), formatNumber(row.bands[2]?.lower)),
                        React.createElement("td", cellProps(DETAIL_COLUMNS, detailPinnedColumns, "k3Upper", "upper-cell"), formatNumber(row.bands[3]?.upper)),
                        React.createElement("td", cellProps(DETAIL_COLUMNS, detailPinnedColumns, "k3Lower", "lower-cell"), formatNumber(row.bands[3]?.lower))
                      )
                    )
                )
              )
            )
          )
        )
      )
    );
  }

  ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App));
})();
// build: 2026-07-02 bugfix
