// 操作 boll_alert_subscriptions KV 里的 watchlist:<email>。
// 用法：
//   node --env-file=.env kv-watchlist.js list                 列出所有账号及其股票
//   node --env-file=.env kv-watchlist.js show <email>         查看某账号
//   node --env-file=.env kv-watchlist.js copy --from <email> --to <email> [--apply]
//   node --env-file=.env kv-watchlist.js copy --codes "688256,300308,AAPL" --to <email> [--apply]
// 不加 --apply 时只做 dry-run 预览，绝不写入。
// token 优先用 CLOUDFLARE_KV_API_TOKEN（需 Workers KV Storage:Edit 权限），否则回退 CLOUDFLARE_API_TOKEN。

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_KV_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
const NS_TITLE = process.env.CLOUDFLARE_KV_TITLE || "boll_alert_subscriptions";

function normalizeSecurityCode(value) {
  const compact = String(value || "").trim().toUpperCase().replace(/\s+/g, "").replace(/[^0-9A-Z.-]/g, "");
  if (/^\d{1,5}$/.test(compact)) return compact.padStart(5, "0");
  if (/^\d{6}$/.test(compact)) return compact;
  const us = compact.replace(/\./g, "-");
  if (/^[A-Z](?:[A-Z0-9-]{0,8}[A-Z0-9])?$/.test(us)) return us;
  return "";
}
function sanitizeCodes(value) {
  const arr = Array.isArray(value) ? value : String(value || "").split(/[,\s]+/);
  return [...new Set(arr.map(normalizeSecurityCode).filter(Boolean))];
}

async function cf(pathname, options = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    ...options,
    headers: { Authorization: `Bearer ${apiToken}`, ...(options.headers || {}) },
  });
  return res;
}
async function cfJson(pathname, options = {}) {
  const res = await cf(pathname, options);
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) {
    throw new Error(`${options.method || "GET"} ${pathname} -> ${res.status} ${JSON.stringify(json?.errors || json)}`);
  }
  return json.result;
}

async function getNamespaceId() {
  const list = await cfJson(`/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
  const ns = list.find((n) => n.title === NS_TITLE);
  if (!ns) throw new Error(`KV namespace "${NS_TITLE}" not found. Have: ${list.map((n) => n.title).join(", ")}`);
  return ns.id;
}
async function readWatchlistCodes(nsId, email) {
  const res = await cf(`/accounts/${accountId}/storage/kv/namespaces/${nsId}/values/${encodeURIComponent(`watchlist:${email}`)}`);
  if (res.status === 404) return { exists: false, codes: [] };
  const text = await res.text();
  try {
    const parsed = JSON.parse(text);
    return { exists: true, codes: sanitizeCodes(Array.isArray(parsed) ? parsed : parsed.codes || []) };
  } catch {
    return { exists: true, codes: [] };
  }
}
async function writeWatchlist(nsId, email, codes) {
  const body = JSON.stringify({ codes, updatedAt: new Date().toISOString() });
  return cfJson(`/accounts/${accountId}/storage/kv/namespaces/${nsId}/values/${encodeURIComponent(`watchlist:${email}`)}`, {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body,
  });
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (key === "apply") out.apply = true;
      else { out[key] = argv[++i]; }
    } else out._.push(a);
  }
  return out;
}

async function main() {
  if (!accountId || !apiToken) throw new Error("缺少 CLOUDFLARE_ACCOUNT_ID 或 token");
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const nsId = await getNamespaceId();

  if (cmd === "list") {
    const keysRes = await cfJson(`/accounts/${accountId}/storage/kv/namespaces/${nsId}/keys?prefix=watchlist:&limit=1000`);
    console.log(`namespace=${NS_TITLE} (${nsId})  accounts=${keysRes.length}`);
    for (const k of keysRes) {
      const email = k.name.replace(/^watchlist:/, "");
      const { codes } = await readWatchlistCodes(nsId, email);
      console.log(`\n• ${email}  (${codes.length})\n  ${codes.join(", ")}`);
    }
    return;
  }

  if (cmd === "show") {
    const email = args._[1];
    if (!email) throw new Error("show 需要 <email>");
    const { exists, codes } = await readWatchlistCodes(nsId, email);
    console.log(`${email}  exists=${exists}  (${codes.length})\n${codes.join(", ")}`);
    return;
  }

  if (cmd === "copy") {
    const to = args.to;
    if (!to) throw new Error("copy 需要 --to <email>");
    let fromCodes = [];
    let fromLabel = "";
    if (args.codes) { fromCodes = sanitizeCodes(args.codes); fromLabel = `codes(${fromCodes.length})`; }
    else if (args.from) {
      const r = await readWatchlistCodes(nsId, args.from);
      if (!r.exists) throw new Error(`来源账号 ${args.from} 不存在`);
      fromCodes = r.codes; fromLabel = `${args.from}(${fromCodes.length})`;
    } else throw new Error("copy 需要 --from <email> 或 --codes \"...\"");

    const target = await readWatchlistCodes(nsId, to);
    const before = target.codes;
    const merged = [...new Set([...before, ...fromCodes])];
    const added = merged.filter((c) => !before.includes(c));

    console.log(`来源 ${fromLabel}`);
    console.log(`目标 ${to} 现有 ${before.length} 只：${before.join(", ") || "(空)"}`);
    console.log(`将新增 ${added.length} 只：${added.join(", ") || "(无)"}`);
    console.log(`合并后共 ${merged.length} 只：${merged.join(", ")}`);

    if (!args.apply) { console.log("\n[dry-run] 未写入。确认无误后加 --apply 实际写入。"); return; }
    await writeWatchlist(nsId, to, merged);
    const verify = await readWatchlistCodes(nsId, to);
    console.log(`\n[已写入] ${to} 现有 ${verify.codes.length} 只：${verify.codes.join(", ")}`);
    return;
  }

  throw new Error(`未知命令：${cmd || "(无)"}。支持 list / show / copy`);
}
main().catch((e) => { console.error("ERR", e.message); process.exitCode = 1; });
