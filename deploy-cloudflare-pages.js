const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const projectName = process.env.CLOUDFLARE_PAGES_PROJECT || "cambricon-boll-midline";
const root = __dirname;

const excluded = new Set([
  ".tools",
  ".claude",
  ".vercelignore",
  "app.js.bak",
  "app.js.bak2",
  "styles.css.bak",
  "styles.css.bak2",
  "cloudflared.exe",
  "cloudflared.out.log",
  "cloudflared.err.log",
  "deploy-cloudflare-pages.js",
  "deploy-subscription-worker.js",
  "deploy-pcb-panel.cmd",
  "PCB_布林带分析.xlsx",
  "preview.png",
  "server.err.log",
  "server.js",
  "server.out.log",
  "subscription-worker.js",
  "verify.js",
  "kv-watchlist.js",
  "audit",
  // _worker.js 不作为静态资源上传；由下面单独以 form 字段方式注入，
  // 触发 Cloudflare Pages 的 Advanced Mode。
  "_worker.js",
]);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jsx": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

function hashFile(filePath) {
  const bytes = fsSync.readFileSync(filePath);
  return crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}

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

async function assetsApi(pathname, jwt, options = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${jwt}`,
      ...(options.headers || {}),
    },
  });
  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.success) {
    throw new Error(`${options.method || "GET"} ${pathname} failed: ${JSON.stringify(json)}`);
  }
  return json.result;
}

async function walk(dir, start = dir, files = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (excluded.has(entry.name)) continue;
    // 绝不把点文件（.env 等机密）上传到公开静态站点。
    if (entry.name.startsWith(".")) continue;
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(start, absolute).split(path.sep).join("/");
    if (relative.startsWith(".tools/")) continue;
    if (entry.isDirectory()) {
      await walk(absolute, start, files);
    } else if (entry.isFile()) {
      files.push({
        path: absolute,
        name: relative,
        hash: hashFile(absolute),
        contentType: contentTypes[path.extname(entry.name)] || "application/octet-stream",
      });
    }
  }
  return files;
}

async function ensureProject() {
  try {
    return await api(`/accounts/${accountId}/pages/projects/${projectName}`);
  } catch {
    return await api(`/accounts/${accountId}/pages/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: projectName,
        production_branch: "main",
      }),
    });
  }
}

async function main() {
  if (!accountId || !apiToken) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required.");
  }

  const files = await walk(root);
  const project = await ensureProject();
  const { jwt } = await api(`/accounts/${accountId}/pages/projects/${projectName}/upload-token`);
  const hashes = files.map((file) => file.hash);
  const missingHashes = await assetsApi("/pages/assets/check-missing", jwt, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hashes }),
  });
  const missing = new Set(missingHashes);
  const payload = await Promise.all(
    files
      .filter((file) => missing.has(file.hash))
      .map(async (file) => ({
        key: file.hash,
        value: (await fs.readFile(file.path)).toString("base64"),
        metadata: { contentType: file.contentType },
        base64: true,
      }))
  );

  if (payload.length) {
    await assetsApi("/pages/assets/upload", jwt, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  await assetsApi("/pages/assets/upsert-hashes", jwt, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hashes }),
  });

  const manifest = Object.fromEntries(files.map((file) => [`/${file.name}`, file.hash]));
  const formData = new FormData();
  formData.append("manifest", JSON.stringify(manifest));
  formData.append("branch", "main");
  formData.append("commit_dirty", "false");
  formData.append("commit_message", "Deploy daily Bollinger middle band calculator");
  formData.append("pages_build_output_dir", ".");

  // Advanced Mode: 项目根目录有 _worker.js 时把它作为单文件 worker 注入。
  const workerPath = path.join(root, "_worker.js");
  let hasWorker = false;
  try {
    const workerSource = await fs.readFile(workerPath, "utf8");
    formData.append(
      "_worker.js",
      new Blob([workerSource], { type: "application/javascript+module" }),
      "_worker.js"
    );
    hasWorker = true;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const deployment = await api(`/accounts/${accountId}/pages/projects/${projectName}/deployments`, {
    method: "POST",
    body: formData,
  });

  console.log(
    JSON.stringify(
      {
        project: project.name,
        subdomain: project.subdomain,
        deploymentUrl: deployment.url,
        aliases: deployment.aliases,
        uploadedFiles: payload.length,
        totalFiles: files.length,
        advancedModeWorker: hasWorker,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
