const fs = require("node:fs/promises");

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const resendApiKey = process.env.RESEND_API_KEY;
const resendFromEmail = process.env.RESEND_FROM_EMAIL || "日布林带 <noreply@solmate.icu>";
const scriptName = process.env.CLOUDFLARE_WORKER_SCRIPT || "boll-alert-subscriptions";
const kvTitle = process.env.CLOUDFLARE_KV_TITLE || "boll_alert_subscriptions";
const workerFile = "subscription-worker.js";
// 主模块之外还需要一并上传的 ES module（Worker 侧以相对路径 import）。
const extraModuleFiles = ["ai-interpreter.js", "snapshot-store.js"];
const d1DatabaseName = process.env.CLOUDFLARE_D1_DATABASE || "boll_snapshots";
// 整体回滚开关：DISABLE_D1=1 时不建库、不加 binding，Worker 侧因 env.DB 缺失自动全 no-op。
const disableD1 = process.env.DISABLE_D1 === "1";

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

// D1 数据库幂等创建：按名字找，找不到就建，返回 uuid（uuid 稳定，每次部署显式带上即可）。
async function ensureD1Database() {
  const list = await api(`/accounts/${accountId}/d1/database`);
  const existing = (list || []).find((database) => database.name === d1DatabaseName);
  if (existing) return existing;
  return api(`/accounts/${accountId}/d1/database`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: d1DatabaseName }),
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

async function uploadWorker(namespaceId, d1DatabaseId) {
  const source = await fs.readFile(workerFile, "utf8");
  const extraModules = await Promise.all(
    extraModuleFiles.map(async (file) => ({ file, source: await fs.readFile(file, "utf8") }))
  );
  const existingBindingNames = await fetchExistingBindingNames();
  const bindings = [
    { type: "kv_namespace", name: "SUBSCRIPTIONS", namespace_id: namespaceId },
  ];
  // 快照落库模块所需（可选）：未绑定时 Worker 侧自动关闭该功能，其余行为不变。
  if (d1DatabaseId) {
    bindings.push({ type: "d1", name: "DB", id: d1DatabaseId });
  }
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
  const d1Database = disableD1 ? null : await ensureD1Database();
  // uploadWorker 返回本次写入的 binding 名单，供下面的 aiInterpreter 状态行使用。
  existingBindingNamesForReport = await uploadWorker(namespace.id, d1Database?.uuid);
  const workerUrl = await enableWorkersDev();
  await setSchedule();
  console.log(
    JSON.stringify(
      {
        scriptName,
        kvNamespace: namespace.title,
        d1Database: disableD1 ? "disabled (DISABLE_D1=1)" : d1DatabaseName,
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
