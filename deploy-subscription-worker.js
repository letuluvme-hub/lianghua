const fs = require("node:fs/promises");

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const resendApiKey = process.env.RESEND_API_KEY;
const resendFromEmail = process.env.RESEND_FROM_EMAIL || "日布林带 <noreply@solmate.icu>";
const scriptName = process.env.CLOUDFLARE_WORKER_SCRIPT || "boll-alert-subscriptions";
const kvTitle = process.env.CLOUDFLARE_KV_TITLE || "boll_alert_subscriptions";
const workerFile = "subscription-worker.js";

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

async function uploadWorker(namespaceId) {
  const source = await fs.readFile(workerFile, "utf8");
  const bindings = [
    { type: "kv_namespace", name: "SUBSCRIPTIONS", namespace_id: namespaceId },
  ];
  // 仅在显式提供了新值时才覆盖 secret_text，否则用 inherit 继承上次部署的值，
  // 避免不小心清空 RESEND_API_KEY 或滚动 ALERT_SECRET 破坏 cron 鉴权。
  bindings.push(
    resendApiKey
      ? { type: "secret_text", name: "RESEND_API_KEY", text: resendApiKey }
      : { type: "inherit", name: "RESEND_API_KEY" }
  );
  bindings.push(
    process.env.RESEND_FROM_EMAIL
      ? { type: "secret_text", name: "RESEND_FROM_EMAIL", text: resendFromEmail }
      : { type: "inherit", name: "RESEND_FROM_EMAIL" }
  );
  bindings.push(
    process.env.ALERT_SECRET
      ? { type: "secret_text", name: "ALERT_SECRET", text: process.env.ALERT_SECRET }
      : { type: "inherit", name: "ALERT_SECRET" }
  );
  const metadata = {
    main_module: workerFile,
    compatibility_date: "2026-05-23",
    bindings,
  };

  const formData = new FormData();
  formData.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  formData.append(workerFile, new Blob([source], { type: "application/javascript+module" }), workerFile);

  return api(`/accounts/${accountId}/workers/scripts/${scriptName}`, {
    method: "PUT",
    body: formData,
  });
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
  await uploadWorker(namespace.id);
  const workerUrl = await enableWorkersDev();
  await setSchedule();
  console.log(
    JSON.stringify(
      {
        scriptName,
        kvNamespace: namespace.title,
        workerUrl,
        resendFromEmail,
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
