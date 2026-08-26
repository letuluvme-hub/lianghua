const fs = require("node:fs/promises");

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const resendApiKey = process.env.RESEND_API_KEY;
const resendFromEmail = process.env.RESEND_FROM_EMAIL || "日布林带 <noreply@solmate.icu>";
const scriptName = process.env.CLOUDFLARE_WORKER_SCRIPT || "boll-alert-subscriptions";
const kvTitle = process.env.CLOUDFLARE_KV_TITLE || "boll_alert_subscriptions";
const workerFile = "subscription-worker.js";
// 主模块之外还需要一并上传的 ES module（Worker 侧以相对路径 import）。
const extraModuleFiles = ["ai-interpreter.js"];

async function api(pathname, options = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      ...(options.headers || {}),
    },
  });
  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.success) {
    throw new Error(`${options.method || "GET"} ${pathname} failed: ${JSON.stringify(json)}`);
  }
  return json.result;
}

async function ensureKvNamespace() {
  const list = await api(`/accounts/${accountId}/storage/kv/namespaces`);
  const existing = list.find((namespace) => namespace.title === kvTitle);
  if (existing) return existing;
  return api(`/accounts/${accountId}/storage/kv/namespaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: kvTitle }),
  });
}

// 已存在的 binding 名单：用于判断 inherit 是否安全（脚本尚未创建时 inherit 会失败）。
// 404（脚本还不存在）→ 空集合；其他错误 → null 表示“未知”，调用方沿用旧行为。
async function fetchExistingBindingNames() {
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/settings`,
      { headers: { Authorization: `Bearer ${apiToken}` } }
    );
    if (response.status === 404) return new Set();
    const json = await response.json().catch(() => null);
    if (!response.ok || !json?.success) return null;
    return new Set((json.result?.bindings || []).map((binding) => binding.name));
  } catch {
    return null;
  }
}

async function uploadWorker(namespaceId) {
  const source = await fs.readFile(workerFile, "utf8");
  const extraModules = await Promise.all(
    extraModuleFiles.map(async (file) => ({ file, source: await fs.readFile(file, "utf8") }))
  );
  const existingBindingNames = await fetchExistingBindingNames();
  const bindings = [
    { type: "kv_namespace", name: "SUBSCRIPTIONS", namespace_id: namespaceId },
  ];
  // 仅在显式提供了新值时才覆盖 secret_text，否则用 inherit 继承上次部署的值，
  // 避免不小心清空 RESEND_API_KEY 或滚动 ALERT_SECRET 破坏 cron 鉴权。
  // 上次部署没有这个 binding 时（比如首次部署、或从未配过 AI Key）直接省略，
  // 因为 inherit 一个不存在的 binding 会让整次上传失败。
  const pushSecret = (name, value, { legacy = false } = {}) => {
    if (value) {
      bindings.push({ type: "secret_text", name, text: value });
      return;
    }
    const unknown = existingBindingNames === null;
    if (existingBindingNames?.has(name) || (unknown && legacy)) {
      bindings.push({ type: "inherit", name });
    }
  };
  pushSecret("RESEND_API_KEY", resendApiKey, { legacy: true });
  pushSecret("RESEND_FROM_EMAIL", process.env.RESEND_FROM_EMAIL ? resendFromEmail : "", { legacy: true });
  pushSecret("ALERT_SECRET", process.env.ALERT_SECRET, { legacy: true });
  // AI 解读模块所需（全部可选）：一个 key 都没有时 Worker 侧自动关闭该功能，
  // 预警邮件按原样发送。两家 key 都配了就用 AI_PROVIDER 指定用哪家。
  pushSecret("DEEPSEEK_API_KEY", process.env.DEEPSEEK_API_KEY);
  pushSecret("DEEPSEEK_MODEL", process.env.DEEPSEEK_MODEL);
  pushSecret("DEEPSEEK_BASE_URL", process.env.DEEPSEEK_BASE_URL);
  pushSecret("ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY);
  pushSecret("ANTHROPIC_MODEL", process.env.ANTHROPIC_MODEL);
  pushSecret("AI_PROVIDER", process.env.AI_PROVIDER);
  const metadata = {
    main_module: workerFile,
    compatibility_date: "2026-05-23",
    bindings,
  };

  const formData = new FormData();
  formData.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  formData.append(workerFile, new Blob([source], { type: "application/javascript+module" }), workerFile);
  for (const module of extraModules) {
    formData.append(
      module.file,
      new Blob([module.source], { type: "application/javascript+module" }),
      module.file
    );
  }

  await api(`/accounts/${accountId}/workers/scripts/${scriptName}`, {
    method: "PUT",
    body: formData,
  });
  // 返回本次实际写入的 binding 名单，供部署结果里说明 AI 解读是开是关。
  return new Set(bindings.map((binding) => binding.name));
}

let existingBindingNamesForReport = new Set();

// 部署结果里的一行人话：AI 解读用了哪家、是不是关着。
function describeAiBinding(names) {
  const hasDeepSeek = names.has("DEEPSEEK_API_KEY");
  const hasAnthropic = names.has("ANTHROPIC_API_KEY");
  if (!hasDeepSeek && !hasAnthropic) {
    return "disabled (set DEEPSEEK_API_KEY or ANTHROPIC_API_KEY to enable)";
  }
  const requested = (process.env.AI_PROVIDER || "").trim().toLowerCase();
  const active =
    requested === "anthropic" && hasAnthropic
      ? "anthropic"
      : requested === "deepseek" && hasDeepSeek
        ? "deepseek"
        : hasDeepSeek
          ? "deepseek"
          : "anthropic";
  const model =
    active === "deepseek"
      ? process.env.DEEPSEEK_MODEL || "deepseek-v4-flash (default)"
      : process.env.ANTHROPIC_MODEL || "claude-opus-5 (default)";
  return `enabled via ${active} (${model})`;
}

async function enableWorkersDev() {
  await api(`/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  const accountSubdomain = await api(`/accounts/${accountId}/workers/subdomain`);
  return `https://${scriptName}.${accountSubdomain.subdomain}.workers.dev`;
}

async function setSchedule() {
  return api(`/accounts/${accountId}/workers/scripts/${scriptName}/schedules`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ cron: "* * * * *" }]),
  });
}

async function main() {
  if (!accountId || !apiToken) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required.");
  }
  const namespace = await ensureKvNamespace();
  existingBindingNamesForReport = await uploadWorker(namespace.id);
  const workerUrl = await enableWorkersDev();
  await setSchedule();
  console.log(
    JSON.stringify(
      {
        scriptName,
        kvNamespace: namespace.title,
        workerUrl,
        resendFromEmail,
        aiInterpreter: describeAiBinding(existingBindingNamesForReport),
        schedule: "* * * * *",
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
