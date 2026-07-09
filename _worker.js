// Cloudflare Pages Advanced Mode worker.
// 浏览器走 Pages 域名（国内可达），_worker.js 把 /api/* 内部转发到
// Workers 域名（Pages → Worker 走 Cloudflare 内部网络，不经公网）。
// 其余请求交给 Pages 静态资源处理。

const WORKER_ORIGIN = "https://boll-alert-subscriptions.letuluvme.workers.dev";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // PCB 专版已并入自选板块看板（PCB 为默认自选之一），旧链接永久重定向。
    if (url.pathname === "/pcb.html") {
      return Response.redirect(`${url.origin}/sectors.html`, 301);
    }

    if (url.pathname.startsWith("/api/")) {
      const target = WORKER_ORIGIN + url.pathname + url.search;
      const init = {
        method: request.method,
        headers: request.headers,
        redirect: "manual",
      };
      if (request.method !== "GET" && request.method !== "HEAD") {
        init.body = request.body;
      }
      return fetch(target, init);
    }

    return env.ASSETS.fetch(request);
  },
};
