/* ============================================================
   股票池批量导入 · 数据与解析工具（纯 JS，挂到 window.PoolData）
   端口自 app.js 的代码识别逻辑，并扩充了一个本地名称库，
   让粘贴常见代码时能立即识别市场与名称。
   ============================================================ */
(function () {
  // —— 本地名称库（演示用；真实环境由行情接口补全名称）——
  const NAME_DB = {
    // AI / 算力
    "688256": "寒武纪", "688802": "沐曦股份", "688795": "摩尔线程", "688041": "海光信息",
    "002230": "科大讯飞", "000977": "浪潮信息", "603019": "中科曙光", "688111": "金山办公",
    "300308": "中际旭创", "300502": "新易盛", "601360": "三六零", "002415": "海康威视",
    // 芯片半导体
    "688981": "中芯国际", "002371": "北方华创", "603501": "韦尔股份", "688012": "中微公司",
    "603986": "兆易创新", "688008": "澜起科技", "002049": "紫光国微", "600584": "长电科技",
    // 新能源 / 锂电
    "300750": "宁德时代", "002594": "比亚迪", "300274": "阳光电源", "300014": "亿纬锂能",
    "002074": "国轩高科", "688390": "固德威", "300438": "鹏辉能源",
    // 锂矿资源
    "002460": "赣锋锂业", "002466": "天齐锂业", "603799": "华友钴业", "002497": "雅化集团",
    "002738": "中矿资源", "603993": "洛阳钼业", "002240": "盛新锂能",
    // 其他蓝筹（扩充）
    "600519": "贵州茅台", "000858": "五粮液", "601318": "中国平安", "000001": "平安银行",
    "600276": "恒瑞医药", "002475": "立讯精密", "300760": "迈瑞医疗", "601899": "紫金矿业",
    "000651": "格力电器", "000333": "美的集团", "600900": "长江电力", "601012": "隆基绿能",
    "002129": "TCL中环", "600030": "中信证券", "601166": "兴业银行", "000725": "京东方A",
    "002714": "牧原股份", "600887": "伊利股份", "601888": "中国中免", "600036": "招商银行",
    // 港股（5 位）
    "00700": "腾讯控股", "01810": "小米集团-W", "09988": "阿里巴巴-W", "03690": "美团-W",
    "00941": "中国移动", "09618": "京东集团-SW", "02020": "安踏体育", "01024": "快手-W",
    "09999": "网易-S", "00388": "香港交易所", "01299": "友邦保险", "02318": "中国平安",
    // 美股
    "AAPL": "苹果", "MSFT": "微软", "NVDA": "英伟达", "TSLA": "特斯拉", "GOOGL": "谷歌A",
    "AMZN": "亚马逊", "META": "Meta", "AMD": "AMD", "INTC": "英特尔", "NFLX": "奈飞",
    "AVGO": "博通", "QCOM": "高通", "ORCL": "甲骨文", "BABA": "阿里巴巴", "PDD": "拼多多",
    "JD": "京东", "NIO": "蔚来", "BIDU": "百度", "ADBE": "Adobe", "CRM": "Salesforce",
  };

  function cleanSecurityInput(value) {
    return String(value || "")
      .toUpperCase()
      .replace(/\s+/g, "")
      .replace(/[^0-9A-Z.\-]/g, "")
      .slice(0, 12);
  }

  function isUsSymbol(code) {
    return /^[A-Z](?:[A-Z0-9-]{0,8}[A-Z0-9])?$/.test(String(code || ""));
  }

  function normalizeSecurityCode(value) {
    const compact = cleanSecurityInput(value);
    if (/^\d{1,5}$/.test(compact)) return compact.padStart(5, "0");
    if (/^\d{6}$/.test(compact)) return compact;
    const usSymbol = compact.replace(/\./g, "-");
    if (isUsSymbol(usSymbol)) return usSymbol;
    return "";
  }

  // 市场大类：A股 / 港股 / 美股
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

  function marketLabel(code) {
    const cat = marketCategory(code);
    if (!cat) return "未知";
    if (cat === "A") {
      const sub = marketSub(code);
      return sub ? `${sub}市 · A股` : "A股";
    }
    return MARKET_SHORT[cat];
  }

  function lookupName(code) {
    return NAME_DB[code] || null;
  }

  /* 把一段自由文本拆成原始 token：支持逗号 / 空格 / 换行 / 制表 / 分号 / 顿号 / 竖线混合 */
  function tokenize(text) {
    return String(text || "")
      .split(/[\s,;，；、|]+/)
      .map((t) => t.trim())
      .filter(Boolean);
  }

  /* 解析单个 token，结合“已有代码集合”判断重复。
     status: ok | duplicate | invalid
     dupOf: 'pool' (已在股票池) | 'batch' (本次粘贴内重复) */
  function classifyToken(raw, poolSet, batchSeen) {
    const code = normalizeSecurityCode(raw);
    if (!code) {
      return { raw, code: "", market: null, name: null, status: "invalid" };
    }
    const market = marketCategory(code);
    const name = lookupName(code);
    if (poolSet && poolSet.has(code)) {
      return { raw, code, market, name, status: "duplicate", dupOf: "pool" };
    }
    if (batchSeen && batchSeen.has(code)) {
      return { raw, code, market, name, status: "duplicate", dupOf: "batch" };
    }
    if (batchSeen) batchSeen.add(code);
    return { raw, code, market, name, status: "ok" };
  }

  /* 解析一组 chip（每个 chip 有自己的 raw），返回带状态的解析结果数组。
     poolSet：股票池现有代码；用于去重判断。 */
  function parseChips(chips, poolSet) {
    const batchSeen = new Set();
    return chips.map((chip) => ({
      id: chip.id,
      ...classifyToken(chip.raw, poolSet, batchSeen),
    }));
  }

  // —— 确定性演示行情（让总览卡片“活”起来，无需联网）——
  function hashCode(str) {
    let h = 2166136261;
    for (let i = 0; i < String(str).length; i++) {
      h ^= String(str).charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function demoMetrics(code) {
    const seed = hashCode(code) || 1;
    const close = 6 + (seed % 580) + ((seed >> 8) % 100) / 100;
    const sigma = ((seed % 701) / 100) - 3.5; // -3.5 ~ 3.5
    const std = Math.max(0.5, close * 0.028);
    const middle = close - sigma * std;
    const bands = {
      1: { upper: middle + std, lower: middle - std },
      2: { upper: middle + 2 * std, lower: middle - 2 * std },
      3: { upper: middle + 3 * std, lower: middle - 3 * std },
    };
    return { close, middle, standardDeviation: std, bands, sigma };
  }

  function classifyBySigma(sigma) {
    if (sigma == null || Number.isNaN(sigma)) return { label: "--", cssClass: "zone-none", sortKey: 99 };
    if (sigma > 3) return { label: "突破K3↑", cssClass: "zone-extreme-up", sortKey: 0 };
    if (sigma > 2) return { label: "K2-K3↑", cssClass: "zone-high-up", sortKey: 1 };
    if (sigma > 1) return { label: "K1-K2↑", cssClass: "zone-mid-up", sortKey: 2 };
    if (sigma > 0) return { label: "中-K1↑", cssClass: "zone-low-up", sortKey: 3 };
    if (sigma > -1) return { label: "K1-中↓", cssClass: "zone-low-dn", sortKey: 4 };
    if (sigma > -2) return { label: "K2-K1↓", cssClass: "zone-mid-dn", sortKey: 5 };
    if (sigma > -3) return { label: "K3-K2↓", cssClass: "zone-high-dn", sortKey: 6 };
    return { label: "突破K3↓", cssClass: "zone-extreme-dn", sortKey: 7 };
  }

  function formatNumber(value, digits = 2) {
    if (value === null || value === undefined || Number.isNaN(value)) return "--";
    return Number(value).toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  let _uid = 0;
  function uid(prefix = "id") {
    _uid += 1;
    return `${prefix}-${Date.now().toString(36)}-${_uid}`;
  }

  window.PoolData = {
    NAME_DB,
    MARKET_SHORT,
    MARKET_DOT,
    cleanSecurityInput,
    isUsSymbol,
    normalizeSecurityCode,
    marketCategory,
    marketSub,
    marketLabel,
    lookupName,
    tokenize,
    classifyToken,
    parseChips,
    demoMetrics,
    classifyBySigma,
    formatNumber,
    uid,
  };
})();
