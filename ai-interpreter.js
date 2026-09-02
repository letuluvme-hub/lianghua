// 预警邮件 AI 解读模块（独立、可选、失败即降级）。
//
// 设计约束：
// 1. 与 subscription-worker.js 一样零依赖，直接用 Worker 原生 fetch 调各家 REST API。
// 2. generateAlertInterpretation 永不 throw，任何异常路径都返回 null，
//    调用方拿到 null 时邮件按原样发送，行为与未接入 AI 时逐字节一致。
// 3. 一个 API Key 都没配时整体关闭：不发请求、不读写 KV、零成本。
//
// 供应商选择（见 pickProvider）：
//   DEEPSEEK_API_KEY  → DeepSeek（OpenAI 兼容接口）
//   ANTHROPIC_API_KEY → Anthropic Messages API
//   两个都配了就用 AI_PROVIDER（"deepseek" / "anthropic"）指定，缺省用 DeepSeek。

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// 安全分类器拒答时由服务端自动换模型重试，保证无人值守 cron 场景下尽量有产出。
const ANTHROPIC_FALLBACK_BETA = "server-side-fallback-2026-07-01";
const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5";
const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";
// deepseek-v4-flash 便宜且足够写这种 300 字技术面短评；换 deepseek-v4-pro 用 DEEPSEEK_MODEL。
const DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash";
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
- 全文不超过 300 字。
- 输入可能附带历史派生信号（streakDays 连续触轨天数、bandwidthChg5d 带宽5日变化、bandwidthPctile120/sigmaPctile250 分位）；提供了就必须在解读中引用它们，说明当前触发在历史中的位置。`;

// FNV-1a 32 位，够用的短哈希（不引依赖）。
function shortHash(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function cacheKeyFor(provider, subscription, alerts) {
  const keys = alerts.map((alert) => alert.alertKey || `${alert.code}:${alert.date}`).sort();
  const rule = [
    subscription?.period ?? "",
    subscription?.multiplier ?? "",
    subscription?.condition ?? "",
  ].join("|");
  const date = alerts.find((alert) => alert.date)?.date || "na";
  // 带上供应商与模型：换模型后不会读到上一个模型留下的解读。
  const seed = `${provider.name}/${provider.model}#${rule}#${keys.join(",")}`;
  return `ai:alert:${date}:${shortHash(seed)}`;
}

function round(value, digits = 3) {
  return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : null;
}

// signalContext（signal-context.js 的产出）为 null、或该 code 没有条目时，
// alert 条目里整体省略 signal 字段，请求体与未接入本模块时逐字节一致。
function signalFor(signalContext, code) {
  const entry = signalContext?.byCode?.[code];
  if (!entry) return null;
  return {
    asOf: entry.asOf,
    streakDays: entry.streakDays,
    bandwidthChg5d: round(entry.bandwidthChg5d),
    bandwidthPctile120: round(entry.bandwidthPctile120),
    sigmaPctile250: round(entry.sigmaPctile250),
    dataDays: entry.dataDays,
  };
}

function buildUserPrompt(subscription, alerts, signalContext = null) {
  const payload = {
    rule: {
      period: subscription?.period ?? null,
      multiplier: subscription?.multiplier ?? null,
      condition: subscription?.condition ?? null,
    },
    alerts: alerts.map((alert) => {
      const signal = signalFor(signalContext, alert.code);
      return {
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
        ...(signal ? { signal } : {}),
      };
    }),
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

// 选供应商：谁的 key 配了就用谁；都配了看 AI_PROVIDER，缺省 DeepSeek。
function pickProvider(env) {
  const requested = (env?.AI_PROVIDER || "").trim().toLowerCase();
  const hasDeepSeek = Boolean(env?.DEEPSEEK_API_KEY);
  const hasAnthropic = Boolean(env?.ANTHROPIC_API_KEY);

  if (requested === "anthropic" && hasAnthropic) return anthropicProvider(env);
  if (requested === "deepseek" && hasDeepSeek) return deepseekProvider(env);
  if (requested && requested !== "anthropic" && requested !== "deepseek") {
    console.warn(`[ai-interpreter] unknown AI_PROVIDER "${requested}", falling back to key detection`);
  }
  if (requested === "anthropic" && !hasAnthropic) {
    console.warn("[ai-interpreter] AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is missing");
  }
  if (requested === "deepseek" && !hasDeepSeek) {
    console.warn("[ai-interpreter] AI_PROVIDER=deepseek but DEEPSEEK_API_KEY is missing");
  }

  if (hasDeepSeek) return deepseekProvider(env);
  if (hasAnthropic) return anthropicProvider(env);
  return null;
}

function deepseekProvider(env) {
  const baseUrl = (env.DEEPSEEK_BASE_URL || DEEPSEEK_DEFAULT_BASE_URL).replace(/\/+$/, "");
  return {
    name: "deepseek",
    model: env.DEEPSEEK_MODEL || DEEPSEEK_DEFAULT_MODEL,
    buildRequest(userPrompt) {
      return {
        url: `${baseUrl}/chat/completions`,
        init: {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: MAX_TOKENS,
            stream: false,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userPrompt },
            ],
          }),
        },
      };
    },
    // OpenAI 兼容响应：choices[0].message.content，finish_reason 标记截断/风控。
    extractText(payload) {
      const choice = payload?.choices?.[0];
      const reason = choice?.finish_reason;
      if (reason === "content_filter") {
        console.warn("[ai-interpreter] deepseek refused (content_filter)");
        return "";
      }
      const text = typeof choice?.message?.content === "string" ? choice.message.content.trim() : "";
      if (!text) console.warn(`[ai-interpreter] deepseek empty text, finish_reason=${reason || "unknown"}`);
      return text;
    },
  };
}

function anthropicProvider(env) {
  return {
    name: "anthropic",
    model: env.ANTHROPIC_MODEL || ANTHROPIC_DEFAULT_MODEL,
    buildRequest(userPrompt) {
      return {
        url: ANTHROPIC_ENDPOINT,
        init: {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": ANTHROPIC_VERSION,
            "anthropic-beta": ANTHROPIC_FALLBACK_BETA,
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: MAX_TOKENS,
            fallbacks: "default",
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: userPrompt }],
          }),
        },
      };
    },
    extractText(payload) {
      if (payload?.stop_reason === "refusal") {
        console.warn("[ai-interpreter] anthropic refused:", payload?.stop_details?.category || "unknown");
        return "";
      }
      const text = Array.isArray(payload?.content)
        ? payload.content
            .filter((block) => block?.type === "text" && typeof block.text === "string")
            .map((block) => block.text)
            .join("")
            .trim()
        : "";
      if (!text) console.warn(`[ai-interpreter] anthropic empty text, stop_reason=${payload?.stop_reason || "unknown"}`);
      return text;
    },
  };
}

async function requestInterpretation(provider, subscription, alerts, signalContext) {
  const { url, init } = provider.buildRequest(buildUserPrompt(subscription, alerts, signalContext));
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.warn(`[ai-interpreter] ${provider.name} http ${response.status}: ${detail.slice(0, 300)}`);
    return null;
  }

  const payload = await response.json();
  const text = provider.extractText(payload);
  if (!text) return null;
  return renderInterpretationHtml(text);
}

/**
 * 生成预警邮件的 AI 解读 HTML 片段。
 * @returns {Promise<string|null>} HTML 片段；null 表示无解读，邮件按原样发送。
 */
export async function generateAlertInterpretation(env, subscription, alerts, signalContext = null) {
  try {
    if (!Array.isArray(alerts) || alerts.length === 0) return null;
    const provider = pickProvider(env);
    if (!provider) return null;

    const cacheKey = cacheKeyFor(provider, subscription, alerts);
    // 同一规则同一天触发多个订阅者时只调一次 API；KV 不可用不影响主流程。
    const cached = await env.SUBSCRIPTIONS?.get(cacheKey).catch((err) => {
      console.warn("[ai-interpreter] cache read failed:", err?.message || err);
      return null;
    });
    if (cached) return cached;

    const html = await requestInterpretation(provider, subscription, alerts, signalContext);
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
