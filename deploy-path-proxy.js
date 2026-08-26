// 部署「子路径挂载」代理 Worker（path-proxy-worker.js）。
//
// 用途：把 Pages 站点挂到国内可达的自有域名子路径下，例如 https://solmate.top/boll。
// 本脚本只负责上传 Worker 脚本本身；最后一步「绑定路由」需要 zone 级
// Workers Routes 权限，用带该权限的令牌运行本脚本时会自动完成，
// 否则脚本会打印出需要在 Cloudflare 面板手动添加的路由，其余步骤照常成功。
//
// 环境变量：
//   CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN  必填
//   PROXY_ZONE      默认 solmate.top      —— 挂载到哪个域名
//   PROXY_PREFIX    默认 /boll            —— 挂载到哪个子路径
//   PAGES_ORIGIN    默认 Pages 站点地址   —— 回源地址
//   PROXY_SCRIPT    默认 boll-path-proxy  —— Worker 脚本名

const fs = require("node:fs/promises");

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const zoneName = process.env.PROXY_ZONE || "solmate.top";
const prefix = `/${(process.env.PROXY_PREFIX || "/boll").replace(/^\/+|\/+$/g, "")}`;
const pagesOrigin = process.env.PAGES_ORIGIN || "https://cambricon-boll-midline.pages.dev";
const scriptName = process.env.PROXY_SCRIPT || "boll-path-proxy";
const workerFile = "path-proxy-worker.js";

async function api(pathname, options = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    ...options,
    headers: { Authorization: `Bearer ${apiToken}`, ...(options.headers || {}) },
  });
  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.success) {
    const error = new Error(`${options.method || "GET"} ${pathname} failed: ${JSON.stringify(json)}`);
    error.status = response.status;
    throw error;
  }
  return json.result;
}

async function uploadWorker() {
  const source = await fs.readFile(workerFile, "utf8");
  const metadata = {
    main_module: workerFile,
    compatibility_date: "2026-05-23",
    bindings: [
      { type: "plain_text", name: "PAGES_ORIGIN", text: pagesOrigin },
      { type: "plain_text", name: "PREFIX", text: prefix },
    ],
  };
  const formData = new FormData();
  formData.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  formData.append(workerFile, new Blob([source], { type: "application/javascript+module" }), workerFile);
  return api(`/accounts/${accountId}/workers/scripts/${scriptName}`, { method: "PUT", body: formData });
}

// 两条精确路由，而不是一条 `/boll*`：后者会连 /bollocks 这类同前缀路径一起吃掉，
// 那些路径本该继续由域名原来的源站处理。
function routePatterns() {
  return [`${zoneName}${prefix}`, `${zoneName}${prefix}/*`];
}

async function ensureRoutes() {
  const zones = await api(`/zones?name=${encodeURIComponent(zoneName)}`);
  const zoneId = zones?.[0]?.id;
  if (!zoneId) throw new Error(`zone ${zoneName} not found`);
  const existing = await api(`/zones/${zoneId}/workers/routes`);
  const have = new Set((existing || []).filter((r) => r.script === scriptName).map((r) => r.pattern));
  const added = [];
  for (const pattern of routePatterns()) {
    if (have.has(pattern)) continue;
    await api(`/zones/${zoneId}/workers/routes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pattern, script: scriptName }),
    });
    added.push(pattern);
  }
  return { zoneId, added, alreadyPresent: [...have] };
}

async function main() {
  if (!accountId || !apiToken) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required.");
  }
  await uploadWorker();

  let routes;
  let routeError = null;
  try {
    routes = await ensureRoutes();
  } catch (error) {
    routeError = error;
  }

  const result = {
    scriptName,
    mountedAt: `https://${zoneName}${prefix}`,
    pagesOrigin,
    workerUploaded: true,
  };
  if (routes) {
    result.routes = { added: routes.added, alreadyPresent: routes.alreadyPresent };
  } else {
    result.routes = "FAILED — 令牌缺少 zone 级 Workers Routes 权限";
    result.manualStep = {
      where: "Cloudflare 面板 → Workers & Pages → " + scriptName + " → Settings → Domains & Routes → Add route",
      patterns: routePatterns(),
      zone: zoneName,
      reason: String(routeError?.message || routeError).slice(0, 200),
    };
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
