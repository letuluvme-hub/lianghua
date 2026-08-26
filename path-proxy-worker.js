// 把 Pages 站点挂到已有域名的子路径下（例：https://solmate.top/boll）。
//
// 背景：*.pages.dev 与 *.workers.dev 在国内不可达，而 solmate.top 已经走
// Cloudflare 代理指向自建 nginx。给这个 Worker 绑一条路由 `solmate.top/boll*`，
// 即可用国内可达的域名访问同一个站点，其余路径仍归 nginx，互不影响。
//
// 前端资源用相对路径（./styles.css 等），API_BASE 也跟随当前路径前缀，
// 所以这里只需剥掉前缀转发，无需改写响应正文。
//
// 可用 plain_text binding 覆盖：PAGES_ORIGIN、PREFIX。

const DEFAULT_PAGES_ORIGIN = "https://cambricon-boll-midline.pages.dev";
const DEFAULT_PREFIX = "/boll";

export default {
  async fetch(request, env) {
    const origin = (env?.PAGES_ORIGIN || DEFAULT_PAGES_ORIGIN).replace(/\/+$/, "");
    const prefix = `/${(env?.PREFIX || DEFAULT_PREFIX).replace(/^\/+|\/+$/g, "")}`;
    const url = new URL(request.url);

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

    const target = new URL(origin);
    target.pathname = url.pathname.slice(prefix.length) || "/";
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
