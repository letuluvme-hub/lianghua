// 把 Pages 站点挂到国内可达的自有域名上。
//
// 背景：*.pages.dev 与 *.workers.dev 在国内不可达。本 Worker 反向代理到
// Pages 站点，绑上自有域名后即可正常访问。
//
// 当前线上形态：Custom Domain = boll.fangtuo.top，整站挂载（PREFIX 为空）。
// 也支持子路径挂载（PREFIX="/boll" + route，如 solmate.top/boll），
// 那种模式下会剥掉前缀回源。
//
// 前端资源用相对路径（./styles.css 等），API_BASE 也跟随当前路径前缀，
// 所以两种模式都无需改写响应正文。
//
// 可用 plain_text binding 覆盖：
//   PAGES_ORIGIN —— 回源地址
//   PREFIX       —— 子路径前缀；留空（或 "/"）表示整个主机名挂载，
//                   给 Worker 绑 Custom Domain（如 boll.fangtuo.top）时用这种。

const DEFAULT_PAGES_ORIGIN = "https://cambricon-boll-midline.pages.dev";
// 默认整站挂载，与线上 boll.fangtuo.top 的形态一致；
// 子路径挂载时用 PREFIX binding 显式指定（如 "/boll"）。
const DEFAULT_PREFIX = "";

// "" 或 "/" → 整个主机名挂载（Custom Domain 模式）；否则返回 "/前缀"（route 模式）。
function normalizePrefix(value) {
  const trimmed = String(value ?? "").replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}` : "";
}

export default {
  async fetch(request, env) {
    const origin = (env?.PAGES_ORIGIN || DEFAULT_PAGES_ORIGIN).replace(/\/+$/, "");
    // PREFIX 为空（或 "/"）表示整个主机名挂载 —— 给 Worker 绑 Custom Domain 时用这种；
    // 非空则是子路径挂载（route 模式），例如 solmate.top/boll。
    const prefix = normalizePrefix(env?.PREFIX ?? DEFAULT_PREFIX);
    const url = new URL(request.url);

    if (prefix) {
      // /boll → /boll/：带上尾斜杠，相对路径（./app.js）才能解析到 /boll/ 之下。
      if (url.pathname === prefix) {
        return new Response(null, {
          status: 308,
          headers: { location: `${prefix}/${url.search}` },
        });
      }
      if (!url.pathname.startsWith(`${prefix}/`)) {
        return new Response("Not found", { status: 404 });
      }
    }

    const target = new URL(origin);
    target.pathname = prefix ? url.pathname.slice(prefix.length) || "/" : url.pathname;
    target.search = url.search;

    const init = { method: request.method, headers: request.headers, redirect: "manual" };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
    }
    const response = await fetch(target, init);

    // 上游若返回指向 pages.dev 的绝对跳转，改写回当前域名的前缀下，
    // 否则国内用户会被甩到不可达的域名上。相对 Location 交给浏览器解析，保持原样。
    const location = response.headers.get("location");
    if (!location) return response;
    let rewritten = location;
    try {
      // 相对 Location 必须以上游请求地址为基准解析（不是 origin 根），
      // 否则 /a/b 下的 "./c" 会被错解成 /c。
      const abs = new URL(location, target);
      if (abs.origin === origin) rewritten = `${prefix}${abs.pathname}${abs.search}${abs.hash}`;
    } catch {
      // Location 非法就原样透传，交给浏览器处理。
    }
    if (rewritten === location) return response;
    const headers = new Headers(response.headers);
    headers.set("location", rewritten);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};
