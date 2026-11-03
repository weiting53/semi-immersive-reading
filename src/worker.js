// Cloudflare Worker:提供 PWA 靜態檔，並在 /api/fetch 代抓 czbooks / 半夏小說的章節頁。
// 只准抓這兩個網站的 https 頁面，避免變成任意代理。抓到的頁面在 Cloudflare 快取 6 小時。
const ALLOWED = ["czbooks.net", "www.xbanxia.cc"];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36";

async function proxy(request) {
  const target = new URL(request.url).searchParams.get("url") || "";
  let u;
  try { u = new URL(target); } catch { return new Response("bad url", { status: 400 }); }
  if (u.protocol !== "https:" || !ALLOWED.includes(u.hostname)) return new Response("host not allowed", { status: 403 });

  const cache = caches.default;
  const key = new Request("https://eread-cache/" + encodeURIComponent(u.href));
  const hit = await cache.match(key);
  if (hit) return hit;

  const r = await fetch(u.href, { headers: { "User-Agent": UA, "Accept-Language": "zh-TW,zh;q=0.9" }, redirect: "follow" });
  if (!r.ok) return new Response("upstream " + r.status, { status: r.status === 404 ? 404 : 502 });
  const res = new Response(await r.text(), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=21600" },
  });
  await cache.put(key, res.clone());
  return res;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/fetch") {
      if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
      return proxy(request);
    }
    return env.ASSETS.fetch(request);
  },
};
