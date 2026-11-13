// Cloudflare Worker:提供 PWA 靜態檔，並在 /api/fetch 代抓小說網站的章節頁。
// 只准抓 public/sites.json 列出的網站(https),避免變成任意代理。抓到的頁面在 Cloudflare 快取 6 小時。
import SITES from "../public/sites.json";

// 免費書庫(古騰堡計畫)也走這裡：瀏覽器不能直接跨站抓它的書目和全文
const ALLOWED = new Set([...SITES.map((s) => s.host), "www.gutenberg.org"]);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36";

async function proxy(request) {
  const params = new URL(request.url).searchParams;
  const target = params.get("url") || "";
  // fresh=1:跳過快取直接抓(最新一章找下一章、重抓目錄時用),抓到的仍會存進快取
  const fresh = params.get("fresh") === "1";
  let u;
  try { u = new URL(target); } catch { return new Response("bad url", { status: 400 }); }
  if (u.protocol !== "https:" || !ALLOWED.has(u.hostname)) return new Response("host not allowed", { status: 403 });

  const cache = caches.default;
  const key = new Request("https://eread-cache/" + encodeURIComponent(u.href));
  const hit = !fresh && (await cache.match(key));
  if (hit) return hit;

  // 轉址只跟到白名單內的網站，避免被轉去別的地方而變成任意代理
  let r, hops = 0;
  for (;;) {
    r = await fetch(u.href, { headers: { "User-Agent": UA, "Accept-Language": "zh-TW,zh;q=0.9" }, redirect: "manual" });
    const loc = r.status >= 300 && r.status < 400 && r.headers.get("location");
    if (!loc) break;
    u = new URL(loc, u);
    if (u.protocol !== "https:" || !ALLOWED.has(u.hostname) || ++hops > 5) return new Response("redirect not allowed", { status: 403 });
  }
  if (!r.ok) return new Response("upstream " + r.status, { status: r.status === 404 ? 404 : r.status === 403 ? 403 : 502 });
  // 有些站是 GBK/Big5 編碼：照 Content-Type 或 <meta charset> 解碼成 UTF-8
  const buf = await r.arrayBuffer();
  const head = new TextDecoder("latin1").decode(buf.slice(0, 2048));
  const cs = ((r.headers.get("content-type") || "").match(/charset=([\w-]+)/i) || head.match(/charset=["']?([\w-]+)/i) || [])[1] || "utf-8";
  let text;
  try { text = new TextDecoder(cs.toLowerCase() === "gb2312" ? "gbk" : cs).decode(buf); } catch { text = new TextDecoder().decode(buf); }
  const res = new Response(text, {
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
      // 有設定 ACCESS_KEY(wrangler secret put ACCESS_KEY)就要帶對的金鑰，避免別人用掉你的額度
      if (env.ACCESS_KEY && request.headers.get("X-Key") !== env.ACCESS_KEY) return new Response("key required", { status: 401 });
      return proxy(request);
    }
    return env.ASSETS.fetch(request);
  },
};
