// 预警邮件 AI 解读模块（独立、可选、失败即降级）。
//
// 设计约束：
// 1. 与 subscription-worker.js 一样零依赖，直接用 Worker 原生 fetch 调 Anthropic REST API。
// 2. generateAlertInterpretation 永不 throw，任何异常路径都返回 null，
//    调用方拿到 null 时邮件按原样发送，行为与未接入 AI 时逐字节一致。
// 3. 未配置 ANTHROPIC_API_KEY 时整体关闭：不发请求、不读写 KV、零成本。

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// 安全分类器拒答时由服务端自动换模型重试，保证无人值守 cron 场景下尽量有产出。
const ANTHROPIC_FALLBACK_BETA = "server-side-fallback-2026-07-01";
const DEFAULT_MODEL = "claude-opus-5";
const MAX_TOKENS = 2000;
const REQUEST_TIMEOUT_MS = 60_000;
const CACHE_TTL_SECONDS = 86_400;
const DISCLAIMER = "本解读由 AI 自动生成，仅供参考，不构成任何投资建议。";

const SYSTEM_PROMPT = `你是一名量化技术分析助手，为个人投资者的布林带预警邮件撰写简短解读。
输入是 JSON：触发预警的股票列表，含收盘价、布林带中线/标准差/上下轨、σ偏离、近20日收盘序列，以及订阅规则（周期N、倍数K、触发条件）。

要求：
- 输出纯文本，不要 Markdown、不要 HTML 标签。段落之间用空行分隔。
- 每只触发股票 2-3 句：说明触发的技术含义（突破方向、偏离程度、结合近20日走势的位置，如带宽收窄/放大、是否连续多日触及轨道）。
- 最后 1 段（1-2 句）：若多只股票同时触发，指出共性；只有一只则给出后续值得关注的技术位。
- 只做技术面客观描述，不预测涨跌，不给出买入/卖出建议，不使用"建议""看好""看空"等措辞。
- 全文不超过 300 字。`;

// FNV-1a 32 位，够用的短哈希（不引依赖）。
function shortHash(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function cacheKeyFor(subscription, alerts) {
  const keys = alerts.map((alert) => alert.alertKey || `${alert.code}:${alert.date}`).sort();
  const rule = [
    subscription?.period ?? "",
    subscription?.multiplier ?? "",
    subscription?.condition ?? "",
  ].join("|");
  const date = alerts.find((alert) => alert.date)?.date || "na";
  return `ai:alert:${date}:${shortHash(`${rule}#${keys.join(",")}`)}`;
}

function round(value, digits = 3) {
  return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : null;
}

function buildUserPrompt(subscription, alerts) {
  const payload = {
    rule: {
      period: subscription?.period ?? null,
      multiplier: subscription?.multiplier ?? null,
      condition: subscription?.condition ?? null,
    },
    alerts: alerts.map((alert) => ({
      name: alert.name,
      code: alert.code,
      date: alert.date,
      close: round(alert.close),
      middle: round(alert.middle),
      standardDeviation: round(alert.standardDeviation),
      side: alert.side,
      boundary: round(alert.boundary),
      sigmaOffset: round(alert.sigmaOffset),
      recentCloses: Array.isArray(alert.recentCloses)
        ? alert.recentCloses.map((row) => ({ date: row.date, close: round(row.close) }))
        : [],
    })),
  };
  return JSON.stringify(payload);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// 模型输出永远当作纯文本处理：先转义再包标签，绝不直接注入 HTML。
function renderInterpretationHtml(text) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `<p style="margin:0 0 10px;">${escapeHtml(part).replaceAll("\n", "<br />")}</p>`)
    .join("");
  if (!paragraphs) return null;
  return `
      <div style="margin:16px 0;padding:14px 16px;border:1px solid #dbeafe;border-left:4px solid #2563eb;border-radius:6px;background:#f8fafc;font-size:13px;line-height:1.7;color:#172033;">
        <div style="font-weight:600;margin-bottom:8px;">AI 解读</div>
        ${paragraphs}
        <p style="margin:10px 0 0;color:#94a3b8;font-size:12px;">${escapeHtml(DISCLAIMER)}</p>
      </div>
  `;
}

function extractText(message) {
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
}

async function requestInterpretation(env, subscription, alerts) {
  const response = await fetch(ANTHROPIC_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": ANTHROPIC_FALLBACK_BETA,
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || DEFAULT_MODEL,
      max_tokens: MAX_TOKENS,
      fallbacks: "default",
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(subscription, alerts) }],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.warn(`[ai-interpreter] http ${response.status}: ${detail.slice(0, 300)}`);
    return null;
  }

  const message = await response.json();
  if (message?.stop_reason === "refusal") {
    console.warn("[ai-interpreter] refused:", message?.stop_details?.category || "unknown");
    return null;
  }
  const text = extractText(message);
  if (!text) {
    console.warn(`[ai-interpreter] empty text, stop_reason=${message?.stop_reason || "unknown"}`);
    return null;
  }
  return renderInterpretationHtml(text);
}

/**
 * 生成预警邮件的 AI 解读 HTML 片段。
 * @returns {Promise<string|null>} HTML 片段；null 表示无解读，邮件按原样发送。
 */
export async function generateAlertInterpretation(env, subscription, alerts) {
  try {
    if (!env?.ANTHROPIC_API_KEY) return null;
    if (!Array.isArray(alerts) || alerts.length === 0) return null;

    const cacheKey = cacheKeyFor(subscription, alerts);
    // 同一规则同一天触发多个订阅者时只调一次 API；KV 不可用不影响主流程。
    const cached = await env.SUBSCRIPTIONS?.get(cacheKey).catch((err) => {
      console.warn("[ai-interpreter] cache read failed:", err?.message || err);
      return null;
    });
    if (cached) return cached;

    const html = await requestInterpretation(env, subscription, alerts);
    if (!html) return null;

    await env.SUBSCRIPTIONS?.put(cacheKey, html, { expirationTtl: CACHE_TTL_SECONDS }).catch((err) => {
      console.warn("[ai-interpreter] cache write failed:", err?.message || err);
    });
    return html;
  } catch (err) {
    console.warn("[ai-interpreter]", err?.message || err);
    return null;
  }
}
