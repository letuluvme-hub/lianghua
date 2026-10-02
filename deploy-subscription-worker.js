const fs = require("node:fs/promises");

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const resendApiKey = process.env.RESEND_API_KEY;
const resendFromEmail = process.env.RESEND_FROM_EMAIL || "日布林带 <noreply@solmate.icu>";
const scriptName = process.env.CLOUDFLARE_WORKER_SCRIPT || "boll-alert-subscriptions";
const kvTitle = process.env.CLOUDFLARE_KV_TITLE || "boll_alert_subscriptions";
const workerFile = "subscription-worker.js";
// 主模块之外还需要一并上传的 ES module（Worker 侧以相对路径 import）。
const extraModuleFiles = ["ai-interpreter.js", "snapshot-store.js", "signal-context.js", "subscription-store.js"];
const d1DatabaseName = process.env.CLOUDFLARE_D1_DATABASE || "boll_snapshots";
// Existing-resource repair only: never remove the verified production DB binding.
const disableD1 = process.env.DISABLE_D1 === "1";
const PRESERVED_SETTINGS = ["compatibility_date", "compatibility_flags", "logpush", "observability", "placement", "limits", "usage_model", "tags", "tail_consumers"];

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
    throw new Error(`${options.method || "GET"} ${pathname} failed (HTTP ${response.status})`);
  }
  return json.result;
}

async function requireKvNamespace() {
  const list = await api(`/accounts/${accountId}/storage/kv/namespaces`);
  const existing = list.find((namespace) => namespace.title === kvTitle);
  if (existing) return existing;
  throw new Error("Expected existing KV namespace was not found; refusing to create a replacement");
}

// Require the existing database. This deployment path cannot create resources.
async function requireD1Database() {
  const list = await api(`/accounts/${accountId}/d1/database`);
  const existing = (list || []).find((database) => database.name === d1DatabaseName);
  if (existing) return existing;
  throw new Error("Expected existing D1 database was not found; refusing to create a replacement");
}

// Unknown or absent settings must fail before any upload, never drop a pause flag.
async function fetchExistingSettings() {
  const settings = await api(`/accounts/${accountId}/workers/scripts/${scriptName}/settings`);
  if (!Array.isArray(settings?.bindings)) throw new Error("Cannot verify existing Worker bindings; refusing deployment");
  if (typeof settings.compatibility_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(settings.compatibility_date)) {
    throw new Error("Cannot verify the existing compatibility date; refusing deployment");
  }
  for (const field of ["assets", "exports", "cache_options"]) {
    const value = settings[field];
    const nonempty = value && (typeof value !== "object" || Object.keys(value).length > 0);
    if (nonempty) throw new Error(`Unsupported existing ${field} configuration; refusing code-only deployment`);
  }
  if (settings.has_assets || settings.bindings.some((binding) => binding.type === "assets")) {
    throw new Error("Existing assets require a separate preservation-aware deployment");
  }
  return settings;
}

function databaseBindingId(bindings) {
  const binding = bindings.find((item) => item.name === "DB");
  if (binding?.database_id && binding?.id && binding.database_id !== binding.id) throw new Error("Conflicting existing D1 binding identifiers");
  return binding?.database_id ?? binding?.id;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function verifySettings(before, after) {
  for (const field of PRESERVED_SETTINGS) {
    if (Object.prototype.hasOwnProperty.call(before, field) && JSON.stringify(canonical(before[field])) !== JSON.stringify(canonical(after[field]))) {
      throw new Error(`Worker uploaded, but preserved setting ${field} differs; inspect deployment before continuing`);
    }
  }
}

async function uploadWorker(namespaceId, d1DatabaseId, existingSettings) {
  const existingBindings = existingSettings.bindings;
  const source = await fs.readFile(workerFile, "utf8");
  const extraModules = await Promise.all(
    extraModuleFiles.map(async (file) => ({ file, source: await fs.readFile(file, "utf8") }))
  );
  const existingBindingNames = new Set(existingBindings.map((binding) => binding.name));
  const bindings = [
    { type: "kv_namespace", name: "SUBSCRIPTIONS", namespace_id: namespaceId },
  ];
  // Keep the verified existing DB binding; no resource deletion or replacement.
  if (d1DatabaseId) {
    bindings.push({ type: "d1", name: "DB", database_id: d1DatabaseId });
  }
  // 仅在显式提供了新值时才覆盖 secret_text，否则用 inherit 继承上次部署的值，
  // 避免不小心清空 RESEND_API_KEY 或滚动 ALERT_SECRET 破坏 cron 鉴权。
  // 上次部署没有这个 binding 时（比如首次部署、或从未配过 AI Key）直接省略，
  // 因为 inherit 一个不存在的 binding 会让整次上传失败。
  const pushSecret = (name, value) => {
    if (value) {
      bindings.push({ type: "secret_text", name, text: value });
      return;
    }
    if (existingBindingNames.has(name)) {
      bindings.push({ type: "inherit", name });
    }
  };
  pushSecret("RESEND_API_KEY", resendApiKey);
  pushSecret("RESEND_FROM_EMAIL", process.env.RESEND_FROM_EMAIL ? resendFromEmail : "");
  pushSecret("ALERT_SECRET", process.env.ALERT_SECRET);
  // AI 解读模块所需（全部可选）：一个 key 都没有时 Worker 侧自动关闭该功能，
  // 预警邮件按原样发送。两家 key 都配了就用 AI_PROVIDER 指定用哪家。
  pushSecret("DEEPSEEK_API_KEY", process.env.DEEPSEEK_API_KEY);
  pushSecret("DEEPSEEK_MODEL", process.env.DEEPSEEK_MODEL);
  pushSecret("DEEPSEEK_BASE_URL", process.env.DEEPSEEK_BASE_URL);
  pushSecret("ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY);
  pushSecret("ANTHROPIC_MODEL", process.env.ANTHROPIC_MODEL);
  pushSecret("AI_PROVIDER", process.env.AI_PROVIDER);
  // Storage-mode changes are an explicit, separately reviewed cutover. Never drop an
  // existing mode binding during an ordinary deployment or silently remove its DB.
  const storageMode = process.env.SUBSCRIPTION_STORAGE_MODE;
  if (storageMode && !["legacy", "handover", "d1"].includes(storageMode)) {
    throw new Error("SUBSCRIPTION_STORAGE_MODE must be legacy, handover, or d1");
  }
  if (storageMode) {
    bindings.push({ type: "plain_text", name: "SUBSCRIPTION_STORAGE_MODE", text: storageMode });
  } else if (existingBindingNames?.has("SUBSCRIPTION_STORAGE_MODE")) {
    bindings.push({ type: "inherit", name: "SUBSCRIPTION_STORAGE_MODE" });
  }
  // Pause-only override. Resume is a separate, explicitly approved operation.
  if (process.env.QUANT_AUTOMATION_PAUSED === "1") {
    bindings.push({ type: "plain_text", name: "QUANT_AUTOMATION_PAUSED", text: "1" });
  } else if (existingBindingNames.has("QUANT_AUTOMATION_PAUSED")) {
    bindings.push({ type: "inherit", name: "QUANT_AUTOMATION_PAUSED" });
  }
  // Preserve unrelated existing bindings too; a code repair must not remove them.
  const included = new Set(bindings.map((binding) => binding.name));
  for (const binding of existingBindings) {
    if (!included.has(binding.name)) bindings.push({ type: "inherit", name: binding.name });
  }
  const metadata = {
    main_module: workerFile,
    bindings,
  };
  // Preserve the existing execution, observability and billing settings. A code
  // repair must not silently replace them with deployment-script defaults.
  for (const field of PRESERVED_SETTINGS) {
    if (Object.prototype.hasOwnProperty.call(existingSettings, field)) metadata[field] = existingSettings[field];
  }

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

  await api(`/accounts/${accountId}/workers/scripts/${scriptName}?bindings_inherit=strict`, {
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

async function existingWorkersDev() {
  const config = await api(`/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`);
  if (typeof config?.enabled !== "boolean") throw new Error("Cannot verify existing workers.dev state");
  if (!config.enabled) return { enabled: false, url: null };
  const accountSubdomain = await api(`/accounts/${accountId}/workers/subdomain`);
  if (!accountSubdomain?.subdomain) throw new Error("Cannot verify existing workers.dev URL");
  return { enabled: true, url: `https://${scriptName}.${accountSubdomain.subdomain}.workers.dev` };
}

async function readSchedules() {
  const result = await api(`/accounts/${accountId}/workers/scripts/${scriptName}/schedules`);
  if (!Array.isArray(result?.schedules) || result.schedules.some((schedule) => typeof schedule?.cron !== "string")) {
    throw new Error("Cannot verify existing schedules; refusing to change them");
  }
  return result.schedules.map((schedule) => schedule.cron).sort();
}

async function main() {
  if (!accountId || !apiToken) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required.");
  }
  if (disableD1) throw new Error("Refusing to remove the existing production DB binding");
  if (process.env.QUANT_AUTOMATION_PAUSED !== undefined && process.env.QUANT_AUTOMATION_PAUSED !== "1") {
    throw new Error("QUANT_AUTOMATION_PAUSED accepts only 1; this deployment cannot resume automation");
  }
  const existingSettings = await fetchExistingSettings();
  const existingBindings = existingSettings.bindings;
  const namespace = await requireKvNamespace();
  const d1Database = await requireD1Database();
  if (existingBindings.find((binding) => binding.name === "SUBSCRIPTIONS")?.namespace_id !== namespace.id ||
      databaseBindingId(existingBindings) !== d1Database.uuid) {
    throw new Error("Existing Worker resource bindings do not match the expected resources; refusing deployment");
  }
  const beforeSchedules = await readSchedules();
  const workersDev = await existingWorkersDev();
  existingBindingNamesForReport = await uploadWorker(namespace.id, d1Database.uuid, existingSettings);
  // Schedule changes are intentionally absent. In particular [] stays paused.
  const afterSchedules = await readSchedules();
  verifySettings(existingSettings, await fetchExistingSettings());
  if (JSON.stringify(beforeSchedules) !== JSON.stringify(afterSchedules)) {
    throw new Error("Worker uploaded, but schedules changed concurrently; inspect pause state before continuing");
  }
  console.log(
    JSON.stringify(
      {
        scriptName,
        kvNamespace: namespace.title,
        d1Database: d1DatabaseName,
        workerUrl: workersDev.url,
        workersDevEnabled: workersDev.enabled,
        resendFromEmail,
        aiInterpreter: describeAiBinding(existingBindingNamesForReport),
        schedules: afterSchedules,
        schedulePolicy: "preserved",
        automationPause: process.env.QUANT_AUTOMATION_PAUSED === "1" ? "set" : "preserved",
      },
      null,
      2
    )
  );
}

module.exports = { main };
if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

