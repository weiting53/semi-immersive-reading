// 半沉浸式英語閱讀 PWA:中文小說夾英文單字。全部在手機瀏覽器裡跑；只有抓網路小說時經過 /api/fetch(Cloudflare Worker)。
(function () {
  "use strict";
  const LV_NAMES = ["原文", "Lv1 多益必考", "Lv2 多益重要", "Lv3 多益常見", "Lv4 加托福雅思", "Lv5 進階同義字與片語"];
  const LV_DESC = ["", "多益必考(5★)", "多益重要(4★)", "多益常見(3★)", "托福/雅思程度", "進階"];
  const PER_LEVEL = 15;

  const store = {
    get(k, d) { try { const v = localStorage.getItem("eread:" + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("eread:" + k, JSON.stringify(v)); } catch (e) { /* 私密瀏覽等情況存不了 */ } },
  };

  let chap = null;
  let level = Math.min(store.get("level", 2), 5);
  let fs = store.get("fs", 19);
  let theme = store.get("theme", null);
  const known = new Set(store.get("known", []));

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // ---------- IndexedDB:章節快取、EPUB ----------
  const dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open("eread", 2);
    req.onupgradeneeded = () => {
      // v2 加 covers(自訂書封)
      for (const s of ["chapters", "epubs", "covers"]) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  async function idb(storeName, mode, fn) {
    const db = await dbp;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const r = fn(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(r && r.result);
      tx.onerror = () => reject(tx.error);
    });
  }
  const idbGet = (s, k) => idb(s, "readonly", (o) => o.get(k));
  const idbPut = (s, k, v) => idb(s, "readwrite", (o) => o.put(v, k));
  const idbDel = (s, k) => idb(s, "readwrite", (o) => o.delete(k));

  // ---------- 單字表 ----------
  let VOCAB = null;
  async function vocab() {
    if (!VOCAB) VOCAB = await (await fetch("data/vocab.json")).json();
    return VOCAB;
  }
  function localVocab(lines) {
    const index = VOCAB.index;
    const counts = new Map();
    for (const line of lines) {
      let i = 0;
      while (i < line.length) {
        let hit = 0;
        for (const n of [6, 5, 4, 3, 2]) {
          const t = line.substr(i, n);
          if (t.length === n && Object.prototype.hasOwnProperty.call(index, t)) {
            counts.set(t, (counts.get(t) || 0) + 1);
            hit = n;
            break;
          }
        }
        i += hit || 1;
      }
    }
    const picked = [], perLevel = {};
    for (const [t, c] of [...counts].sort((a, b) => b[1] - a[1])) {
      const cands = index[t].map((en) => ({ en, ...VOCAB.words[en] }));
      const lv = Math.min(...cands.map((x) => x.level));
      if ((perLevel[lv] || 0) >= PER_LEVEL) continue;
      perLevel[lv] = (perLevel[lv] || 0) + 1;
      picked.push({ zh: t, count: c, cands });
    }
    return picked;
  }

  // ---------- 簡體 → 台灣繁體 ----------
  let s2t = null;
  function toTrad(lines) {
    if (!s2t) {
      if (!window.OpenCC) return lines;
      s2t = OpenCC.Converter({ from: "cn", to: "twp" });
    }
    const text = lines.join("\n"), conv = s2t(text);
    let diff = 0;
    for (let i = 0; i < Math.min(text.length, conv.length); i++) if (text[i] !== conv[i]) diff++;
    return conv.length !== text.length || diff > text.length * 0.002 ? conv.split("\n") : lines;
  }

  // ---------- 網址 ----------
  // 支援的網站在 sites.json(Worker 也用同一份當白名單)
  let SITES = [];
  async function sites() {
    if (!SITES.length) SITES = await (await fetch("sites.json")).json();
    return SITES;
  }
  const siteOf = (host) => SITES.find((x) => x.host === host || (x.aliases || []).includes(host));
  function normalize(url) {
    url = url.trim();
    if (url.startsWith("//")) url = "https:" + url;
    if (/^epub:\/\/[0-9a-f]{12}\/\d+$/.test(url)) return url;
    let u;
    try { u = new URL(url); } catch (e) { throw new Error("網址格式不對"); }
    const site = siteOf(u.hostname);
    if (!site) throw new Error("還不支援這個網站。目前支援:" + SITES.map((x) => x.name).join("、") + ",或匯入 EPUB、貼上文字。");
    return "https://" + site.host + u.pathname + u.search;
  }
  function bookId(url) {
    const u = new URL(url.replace(/^epub:/, "https:"));
    if (url.startsWith("epub:")) return "epub-" + u.hostname;
    const m = u.pathname.match(/^\/(?:n|books)\/([^/.]+)/);
    return m ? u.hostname + ":" + m[1] : url;
  }

  // ---------- 抓章節 ----------
  // fresh:跳過 Worker 和瀏覽器的快取(兩邊都會留 6 小時),用在可能有新章節的時候
  async function fetchHTML(url, fresh) {
    const r = await fetch("api/fetch?url=" + encodeURIComponent(url) + (fresh ? "&fresh=1" : ""),
      { headers: { "X-Key": store.get("key", "") }, cache: fresh ? "no-store" : "default" });
    if (r.status === 401) throw new Error("這個網站需要存取金鑰才能抓小說。請在下面貼上金鑰(EPUB 和貼上文字不需要金鑰)。");
    const site = siteOf(new URL(url).hostname);
    if (r.status === 403 && site && site.cloudBlocked) {
      throw new Error(site.name + "擋掉了雲端抓取，手機版讀不到。可以改用電腦版(server.py,同一個 Wi-Fi),或轉成 EPUB 匯入、貼上文字。");
    }
    if (!r.ok) throw new Error(r.status === 404 ? "網站找不到這一頁" : `抓取失敗(${r.status})`);
    return r.text();
  }
  // 401 時直接在畫面上輸入金鑰(主畫面 App 和 Safari 的資料分開，Safari 開過 ?key= 也不會帶過來)
  const errHtml = (msg) => `<p class="err">${esc(msg)}</p>` + (/金鑰/.test(msg) ? `
    <form class="add keyform"><input name="k" type="password" autocomplete="off" placeholder="貼上存取金鑰"><button>儲存</button></form>` : "");
  document.addEventListener("submit", (e) => {
    if (!e.target.classList.contains("keyform")) return;
    e.preventDefault();
    const k = e.target.k.value.trim();
    if (!k) return;
    store.set("key", k);
    alert("金鑰已儲存");
    location.reload();
  });

  function stripTags(s) {
    const t = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|h[1-6]|li|tr)\s*>/gi, "\n").replace(/<[^>]+>/g, "");
    const ta = document.createElement("textarea");
    ta.innerHTML = t;
    return ta.value;
  }
  const toLines = (s) => stripTags(s).split("\n").map((l) => l.trim()).filter(Boolean);
  const abs = (href, base) => normalize(new URL(href.trim(), base).href);

  function chapterObj(url, book, title, lines, prev, next) {
    const all = toTrad([book, title, ...lines]);
    return { url, book: all[0], title: all[1], lines: all.slice(2), prev, next };
  }

  function parseCzbooks(url, page) {
    const m = page.match(/<div class\s*=\s*"content"\s*>([\s\S]*?)<\/div>/);
    if (!m) throw new Error("找不到章節內文(網站格式可能變了)");
    const name = page.match(/<h1 class="name">([\s\S]*?)<\/h1>/);
    const full = name ? stripTags(name[1]).trim() : "";
    const bm = full.match(/《(.*?)》\s*(.*)/);
    const link = (cls) => { const a = page.match(new RegExp(`<a class="${cls}"[^>]*href="([^"]+)"`)); return a ? abs(a[1], url) : null; };
    return chapterObj(url, bm ? bm[1] : "", bm ? bm[2] : full, toLines(m[1]), link("prev-chapter"), link("next-chapter"));
  }

  function parseBanxia(url, page) {
    let i = page.indexOf('id="nr1"');
    if (i < 0) throw new Error("找不到章節內文(半夏小說格式可能變了)");
    i = page.indexOf(">", i) + 1;
    const ends = ['<div id="anchor"', "<form", 'class="issue'].map((m) => page.indexOf(m, i)).filter((e) => e > 0);
    let body = page.slice(i, ends.length ? Math.min(...ends) : undefined);
    body = body.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g, "");
    const lines = toLines(body).filter((l) => !l.includes("半夏小說") && l !== "錯誤提交");
    const t = page.match(/<h1 id="nr_title"[^>]*>([\s\S]*?)<\/h1>/);
    const bk = page.match(/id="bcrumb"[\s\S]*?<a href="[^"]*\/books\/\d+\.html"[^>]*>([\s\S]*?)<\/a>/);
    const link = (id) => {
      const a = page.match(new RegExp(`href="([^"]+?)\\s*"[^>]*id="${id}"`));
      if (!a) return null;
      const href = new URL(a[1].trim(), url).href;
      return /\/books\/\d+\/\d+\.html$/.test(href) ? normalize(href) : null;
    };
    return chapterObj(url, bk ? stripTags(bk[1]).trim() : "", t ? stripTags(t[1]).trim() : "", lines, link("prev_url"), link("next_url"));
  }

  // 通用擷取：找文字最多的內文區塊，加上「上一章 / 下一章」連結。新網站加進 sites.json 用 "parser": "generic" 就好
  function parseGeneric(url, page) {
    const doc = new DOMParser().parseFromString(page, "text/html");
    const siteName = (siteOf(new URL(url).hostname) || {}).name || "";
    // 上一章 / 下一章:rel、id/class 含 prev/next,或連結文字(含外層 li 的文字)
    const link = (dir) => {
      const re = dir === "prev" ? /^(上一?章|上一頁|上一页|上章)/ : /^(下一?章|下一頁|下一页|下章)/;
      const a = [...doc.querySelectorAll("a[href]")].find((x) =>
        x.rel === dir || new RegExp(`(^|[_-])${dir}`, "i").test(x.id + " " + x.className) ||
        re.test(x.textContent.trim()) || (x.parentElement && re.test(x.parentElement.textContent.trim())));
      const href = a && a.getAttribute("href");
      if (!href || href.startsWith("javascript") || href === "#") return null;
      try { return normalize(new URL(href.trim(), url).href); } catch (e) { return null; }
    };
    const prev = link("prev"), next = link("next");

    // 章名：找內容出現在 <title> 裡的 h1~h3;書名:og:novel:book_name,否則從 <title> 拆
    const pageTitle = doc.title.trim();
    const hs = [...doc.querySelectorAll("h1,h2,h3")].map((h) => h.textContent.trim()).filter((t) => t.length > 1 && t !== siteName);
    const title = hs.find((t) => pageTitle.includes(t)) || hs[0] || pageTitle.split(/\s[-_|]\s|[-_|]/)[0].trim();
    const meta = (k) => { const m = doc.querySelector(`meta[property="${k}"],meta[name="${k}"]`); return m ? m.content.trim() : ""; };
    const book = meta("og:novel:book_name") ||
      pageTitle.split(/\s+[-_|]\s+|[-_|]|\s{2,}/).map((x) => x.replace(title, "").trim()).find((x) => x && x !== siteName && !x.includes(siteName)) || "";

    // 內文：常見的內文容器，找不到就挑「直接文字 + <br>/<p> 最多」的區塊
    doc.querySelectorAll("script,style,noscript,iframe,ins,form,header,footer,nav").forEach((e) => e.remove());
    let best = doc.querySelector("#content,#chaptercontent,#chapterContent,#booktxt,#txtnav,#htmlContent,#nr1,#BookText,.read-content,.chapter-content,.content,.txtnav");
    if (!best) {
      let bestScore = 0;
      for (const el of doc.querySelectorAll("div,article,section")) {
        const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim().length;
        const score = own + el.querySelectorAll(":scope > br, :scope > p").length * 20;
        if (score > bestScore) { best = el; bestScore = score; }
      }
    }
    if (!best) throw new Error("找不到章節內文");
    const html = best.innerHTML.replace(/<!--[\s\S]*?-->/g, "");
    const lines = toLines(html).filter((l) => /[一-鿿A-Za-z0-9]/.test(l) && l !== title && !(siteName && l.includes(siteName)));
    return chapterObj(url, book, title, lines, prev, next);
  }

  // 書本首頁 → 第一章
  async function resolveBook(url) {
    const u = new URL(url);
    let m = u.hostname.endsWith("xbanxia.cc") && u.pathname.match(/^\/books\/(\d+)\.html$/);
    if (m) {
      const page = await fetchHTML(url);
      const links = [...page.matchAll(new RegExp(`href="(/books/${m[1]}/\\d+\\.html)"[^>]*>([^<]*)`, "g"))]
        .filter((x) => !x[2].includes("章節列表"));
      if (!links.length) throw new Error("書本頁找不到章節列表");
      const first = links.find((x) => x[2].trim().startsWith("第")) || links[0];
      return abs(first[1], url);
    }
    m = u.hostname.endsWith("czbooks.net") && u.pathname.match(/^\/n\/([^/]+)\/?$/);
    if (m) {
      const page = await fetchHTML(url);
      const links = [...page.matchAll(new RegExp(`href="(//czbooks\\.net/n/${reEsc(m[1])}/[^"?]+\\?chapterNumber=(\\d+))"`, "g"))];
      if (!links.length) throw new Error("書本頁找不到章節列表");
      links.sort((a, b) => +a[2] - +b[2]);
      return abs(links[0][1], url);
    }
    return url;
  }

  async function getChapter(url) {
    if (url.startsWith("epub://")) {
      const [, id, n] = url.match(/^epub:\/\/([0-9a-f]{12})\/(\d+)$/);
      const lib = await idbGet("epubs", id);
      if (!lib) throw new Error("這本 EPUB 不在這支手機上，請重新匯入");
      const k = +n, chs = lib.chapters;
      if (k < 1 || k > chs.length) throw new Error("這本 EPUB 沒有這一章");
      const mk = (j) => (j >= 1 && j <= chs.length ? `epub://${id}/${j}` : null);
      const c = chs[k - 1];
      // 書籤加入的書：最後一章的「下一章」要回原網站打開，再按一次書籤
      return { ...chapterObj(url, lib.book, c.title, c.lines, mk(k - 1), mk(k + 1)), total: chs.length,
        src: c.src || null, srcNext: k === chs.length ? c.next || null : null };
    }
    const cached = await idbGet("chapters", url);
    if (cached && cached.next) return cached;
    // 沒有下一章的章節(讀到最新一章)不能一直用快取，否則網站出了新章也不會出現「下一章」
    const parse = async (fresh) => {
      const page = await fetchHTML(url, fresh);
      const parser = (siteOf(new URL(url).hostname) || {}).parser;
      return parser === "banxia" ? parseBanxia(url, page) : parser === "czbooks" ? parseCzbooks(url, page) : parseGeneric(url, page);
    };
    let ch;
    if (cached) {
      try { ch = await parse(true); } catch (e) { return cached; }
    } else ch = await parse(false);
    await idbPut("chapters", url, ch);
    return ch;
  }

  function prefetch(url) {
    if (!url || url.startsWith("epub://")) return;
    idbGet("chapters", url).then((c) => { if (!c) getChapter(url).catch(() => {}); });
  }

  // ---------- 目錄：EPUB/貼上文字直接列；網站從書本首頁抓章節列表，存在 IndexedDB ----------
  function parseTocCzbooks(page, id) {
    const seen = new Set(), out = [];
    for (const m of page.matchAll(new RegExp(`<a href="(//czbooks\\.net/n/${reEsc(id)}/[^"?]+\\?chapterNumber=(\\d+))"[^>]*>([^<]*)</a>`, "g"))) {
      if (seen.has(m[2])) continue;
      seen.add(m[2]);
      out.push({ n: +m[2], t: stripTags(m[3]).trim(), u: "https:" + m[1] });
    }
    return out.sort((a, b) => a.n - b.n).map(({ t, u }) => ({ t, u }));
  }
  function parseTocBanxia(page, base, id) {
    const seen = new Set(), out = [];
    for (const m of page.matchAll(new RegExp(`href="(/books/${id}/\\d+\\.html)"[^>]*>([^<]*)`, "g"))) {
      if (seen.has(m[1]) || m[2].includes("章節列表")) continue;
      seen.add(m[1]);
      out.push({ t: stripTags(m[2]).trim(), u: abs(m[1], base) });
    }
    return out;
  }
  // 通用：章節頁找「目錄」連結，再把目錄頁上同網站、像章名的連結依序列出
  async function tocGeneric(url, fresh) {
    const doc = new DOMParser().parseFromString(await fetchHTML(url), "text/html");
    const a = [...doc.querySelectorAll("a[href]")].find((x) => /^(目錄|目录|章節目錄|章节目录|章節列表|章节列表|返回目錄|返回目录)$/.test(x.textContent.trim()));
    if (!a) throw new Error("這個網站找不到目錄頁");
    const tocUrl = normalize(new URL(a.getAttribute("href").trim(), url).href);
    const d2 = new DOMParser().parseFromString(await fetchHTML(tocUrl, fresh), "text/html");
    const host = new URL(url).hostname, seen = new Set(), out = [];
    for (const x of d2.querySelectorAll("a[href]")) {
      const t = x.textContent.trim();
      if (!/^(第[\d一二三四五六七八九十百千零〇兩两]+[章回節节卷]|\d+[.、 ]|序|楔子|番外|尾聲|尾声|後記|后记|終章|终章)/.test(t)) continue;
      let u; try { u = new URL(x.getAttribute("href").trim(), tocUrl); } catch (e) { continue; }
      if (u.hostname !== host || seen.has(u.href)) continue;
      seen.add(u.href);
      try { out.push({ t, u: normalize(u.href) }); } catch (e) { /* 不支援的網址 */ }
    }
    return out;
  }
  async function getToc(ch, refresh) {
    const em = ch.url.match(/^epub:\/\/([0-9a-f]{12})\//);
    if (em) {
      const lib = await idbGet("epubs", em[1]);
      return lib ? toTrad(lib.chapters.map((c) => c.title)).map((t, i) => ({ t, u: `epub://${em[1]}/${i + 1}` })) : [];
    }
    const key = "toc:" + bookId(ch.url);
    const c = await idbGet("chapters", key);
    let fresh = !!refresh;
    if (!refresh && c) {
      // 連載中的書：目前這章不在舊目錄裡就重抓；正在讀目錄最後一章時也跳過快取重抓，才看得到新章
      const i = c.list.findIndex((x) => x.u === ch.url);
      if (i >= 0 && i < c.list.length - 1) return c.list;
      fresh = i >= 0;
    }
    const u = new URL(ch.url);
    let list, m;
    try {
      if ((m = u.hostname.endsWith("czbooks.net") && u.pathname.match(/^\/n\/([^/]+)/))) {
        list = parseTocCzbooks(await fetchHTML("https://czbooks.net/n/" + m[1], fresh), m[1]);
      } else if ((m = u.hostname.endsWith("xbanxia.cc") && u.pathname.match(/^\/books\/(\d+)\//))) {
        const book = `https://${u.hostname}/books/${m[1]}.html`;
        list = parseTocBanxia(await fetchHTML(book, fresh), book, m[1]);
      } else {
        list = await tocGeneric(ch.url, fresh);
      }
    } catch (e) {
      if (c && !refresh) return c.list; // 重抓失敗(離線等)就先用舊目錄
      throw e;
    }
    if (!list.length) throw new Error("找不到章節列表(網站格式可能變了)");
    const trad = toTrad(list.map((x) => x.t));
    list = list.map((x, i) => ({ t: trad[i] || x.t, u: x.u }));
    await idbPut("chapters", key, { list, at: Date.now() });
    return list;
  }

  const TOC_H = `<h2 style="font-family:var(--sans);font-size:20px">目錄</h2>`;
  async function showToc(refresh) {
    if (!chap) return;
    const ch = chap;
    openSheet(TOC_H + `<p class="sub">讀取中…</p>`);
    let list;
    try { list = await getToc(ch, refresh); }
    catch (e) { if (chap === ch && $("sheet").classList.contains("open")) openSheet(TOC_H + errHtml(e.message || String(e))); return; }
    if (chap !== ch || !$("sheet").classList.contains("open")) return;
    const read = new Set(store.get("bc:" + bookId(ch.url), []));
    const cur = list.findIndex((x) => x.u === ch.url);
    openSheet(`<div class="toc-top">
      <div class="toc-h">${TOC_H}<span class="sub" style="margin:0">共 ${list.length} 章${cur >= 0 ? ` · 正在讀第 ${cur + 1} 章` : ""}</span></div>
      <div class="add toc-tools">
        <input id="tocQ" type="search" autocomplete="off" placeholder="搜尋章名，或輸入章數跳過去">
        ${ch.url.startsWith("epub") ? "" : `<button type="button" class="clip" id="tocRf" aria-label="重新抓目錄">↻</button>`}
      </div>
      <div class="toc-jump">
        <button type="button" data-tocjump="0">第一章</button>
        ${cur >= 0 ? `<button type="button" data-tocjump="${cur}">目前章節</button>` : ""}
        <button type="button" data-tocjump="${list.length - 1}">最新章</button>
      </div></div>
      <ol class="toc" id="tocList">${list.map((x, i) => `
        <li data-go="${esc(x.u)}" data-i="${i}" class="${i === cur ? "cur" : read.has(x.u) ? "read" : ""}"><span class="n">${i + 1}</span><span class="t">${esc(x.t)}</span></li>`).join("")}</ol>`);
    const items = [...$("tocList").children];
    if (cur >= 0) tocJump(cur);
    $("tocQ").oninput = (e) => {
      const q = toTrad([e.target.value.trim()])[0];
      if (/^\d+$/.test(q)) { items.forEach((el) => (el.hidden = false)); tocJump(+q - 1); return; }
      items.forEach((el) => (el.hidden = !!q && !el.textContent.includes(q)));
    };
    if ($("tocRf")) $("tocRf").onclick = () => showToc(true);
  }
  function tocJump(i) {
    const items = $("tocList") ? $("tocList").children : [];
    const el = items[Math.max(0, Math.min(items.length - 1, i))], sh = $("sheet");
    if (el) sh.scrollTop = el.offsetTop - sh.clientHeight / 2 + el.offsetHeight;
  }

  // ---------- EPUB 匯入(全部在手機上處理，不上傳) ----------
  async function importEpub(file) {
    const buf = await file.arrayBuffer();
    const hash = await crypto.subtle.digest("SHA-1", buf);
    const id = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
    const zip = await JSZip.loadAsync(buf);
    const read = async (p) => { const f = zip.file(p); if (!f) throw new Error("EPUB 少了 " + p); return f.async("string"); };
    const container = await read("META-INF/container.xml");
    const opfPath = (container.match(/full-path="([^"]+)"/) || [])[1];
    if (!opfPath) throw new Error("這不是有效的 EPUB 檔");
    const opf = await read(opfPath);
    const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
    const tm = opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/);
    const book = tm ? stripTags(tm[1]).trim() : file.name.replace(/\.epub$/i, "");
    const manifest = {};
    for (const item of opf.match(/<item\b[^>]*>/g) || []) {
      const iid = item.match(/\bid="([^"]+)"/), href = item.match(/\bhref="([^"]+)"/);
      if (iid && href) manifest[iid[1]] = decodeURIComponent(href[1]);
    }
    const chapters = [];
    for (const m of opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/g)) {
      const href = manifest[m[1]];
      if (!href || !/\.x?html?$/i.test(href)) continue;
      const f = zip.file(base + href);
      if (!f) continue;
      let doc = (await f.async("string")).replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, "");
      const tt = doc.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
      let lines = toLines(doc);
      if (lines.length < 3) continue; // 封面、版權頁
      const title = tt ? stripTags(tt[1]).trim() : lines[0].slice(0, 30);
      if (tt && lines[0] === title) lines = lines.slice(1);
      chapters.push({ title, lines });
    }
    if (!chapters.length) throw new Error("EPUB 裡找不到文字章節");
    await idbPut("epubs", id, { book, file: file.name, chapters });
    // EPUB 整本都在手機上，匯入時就算出全書可學的單字
    await vocab();
    const all = new Set();
    for (const c of chapters) for (const en of wordsIn(toTrad(c.lines))) all.add(en);
    store.set("bw:epub-" + id, [...all]);
    return `epub://${id}/1`;
  }

  // ---------- 貼上文字：任何平台都能用。同一個書名會接成下一章 ----------
  // 書籤小工具(clip.html)複製的章節:"EREAD1:" + JSON {b 書名, t 章名, l 段落, n 下一章網址, u 原網址}
  function parseClip(text) {
    const s = (text || "").trim();
    if (!s.startsWith("EREAD1:")) return null;
    try {
      const d = JSON.parse(s.slice(7));
      return Array.isArray(d.l) && d.l.length ? d : null;
    } catch (e) { return null; }
  }

  async function addPaste(book, title, text, meta = {}) {
    book = book.trim() || "貼上的文字";
    const lines = meta.lines || text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error("沒有貼上任何文字");
    const hash = await crypto.subtle.digest("SHA-1", new TextEncoder().encode("paste:" + book));
    const id = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
    const lib = (await idbGet("epubs", id)) || { book, file: "", chapters: [] };
    const c = { title: title.trim() || `第 ${lib.chapters.length + 1} 段`, lines };
    if (meta.src) { c.src = meta.src; c.next = meta.next || null; }
    // 同一章按了兩次書籤：蓋掉舊的，不重複加
    let i = meta.src ? lib.chapters.findIndex((x) => x.src === meta.src) : -1;
    if (i >= 0) lib.chapters[i] = c; else { lib.chapters.push(c); i = lib.chapters.length - 1; }
    await idbPut("epubs", id, lib);
    await vocab();
    const all = new Set(store.get("bw:epub-" + id, []));
    for (const en of wordsIn(toTrad(lines))) all.add(en);
    store.set("bw:epub-" + id, [...all]);
    return `epub://${id}/${i + 1}`;
  }
  async function addClip(d) {
    const url = await addPaste(d.b || "", d.t || "", "", { lines: d.l, src: d.u, next: d.n });
    await load(url);
    const id = bookId(url); const s2 = store.get("shelf", {}); if (s2[id]) { s2[id].paste = true; store.set("shelf", s2); }
  }

  function showPaste() {
    const shelf = store.get("shelf", {});
    const lastPaste = Object.values(shelf).filter((b) => b.url.startsWith("epub") && b.paste).sort((a, b) => b.at - a.at)[0];
    openSheet(`
      <h2 style="font-family:var(--sans);font-size:20px">貼上文字</h2>
      <p class="sub">從任何 App 或網站複製一章貼進來。書名一樣的會接成下一章。</p>
      <input id="pBook" class="field" placeholder="書名" value="${lastPaste ? esc(lastPaste.book) : ""}">
      <input id="pTitle" class="field" placeholder="章名(可留空)">
      <textarea id="pText" class="field" rows="8" placeholder="把章節文字貼在這裡"></textarea>
      <p class="sub" id="pMsg"></p>
      <div class="btns"><button class="primary" id="pGo">開始讀</button></div>
      <h2 style="font-family:var(--sans);font-size:17px;margin-top:22px">從網站書籤加入</h2>
      <p class="sub">在 Safari 打開章節、按「送進英讀書庫」書籤，再回來按這裡。<a href="clip.html" target="_blank" rel="noopener">怎麼裝書籤</a></p>
      <div class="btns"><button id="pClip">從剪貼簿加入章節</button></div>`);
    $("pClip").onclick = async () => {
      let t = "";
      try { t = await navigator.clipboard.readText(); }
      catch (e) { $("pMsg").textContent = "讀不到剪貼簿。請把剪貼簿內容貼進上面的大框框，再按「開始讀」。"; return; }
      const d = parseClip(t);
      if (!d) { $("pMsg").textContent = "剪貼簿裡不是書籤複製的章節。請先在 Safari 的章節頁按書籤。"; return; }
      try { closeSheet(); await addClip(d); } catch (err) { alert(err.message); }
    };
    $("pGo").onclick = async () => {
      try {
        const d = parseClip($("pText").value);
        if (d) { closeSheet(); await addClip(d); return; }
        const url = await addPaste($("pBook").value, $("pTitle").value, $("pText").value);
        closeSheet();
        await load(url);
        const id = bookId(url); const s2 = store.get("shelf", {}); if (s2[id]) { s2[id].paste = true; store.set("shelf", s2); }
      } catch (err) { $("pMsg").textContent = err.message; }
    };
  }

  // ---------- 整本書(TXT、免費書庫)存成跟 EPUB 一樣的格式，放上書架但先不打開 ----------
  async function hashId(s) {
    const h = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
  }
  async function saveBook(id, book, chapters, meta) {
    await idbPut("epubs", id, { book, file: meta.file || "", chapters });
    await vocab();
    const all = new Set();
    for (const c of chapters) for (const en of wordsIn(toTrad(c.lines))) all.add(en);
    store.set("bw:epub-" + id, [...all]);
    const s = store.get("shelf", {});
    s["epub-" + id] = { ...(s["epub-" + id] || {}), book: toTrad([book])[0], title: "", fresh: true, url: `epub://${id}/1`,
      idx: 0, total: chapters.length, src: meta.src, author: meta.author || "", at: Math.floor(Date.now() / 1000) };
    store.set("shelf", s);
    return `epub://${id}/1`;
  }

  // 純文字切章：認「第X章/回」這類標題；固定寬度斷行的文字(古騰堡)會先接回段落
  const HEAD_RE = /^\s*(第[\d０-９一二三四五六七八九十百千零〇兩两]+[章回節节卷部集]|序章|序言|楔子|引子|番外|尾聲|尾声|後記|后记)/;
  function textToChapters(text) {
    const mode = (arr) => { const f = {}; arr.forEach((x) => (f[x] = (f[x] || 0) + 1)); const t = Object.entries(f).sort((a, b) => b[1] - a[1])[0]; return t ? [+t[0], t[1]] : [0, 0]; };
    const rows = text.replace(/\r/g, "").split("\n").map((l) => ({
      t: l.trim(), ind: l.match(/^[ \t\u3000]*/)[0].replace(/\u3000/g, "  ").replace(/\t/g, "    ").length }));
    const body = rows.filter((r) => r.t.length > 10);
    const [width, wn] = mode(body.map((r) => r.t.length));
    const wrapped = width >= 20 && wn > body.length * 0.25;   // 固定寬度斷行：滿寬的行要接下一行
    const [bodyInd] = mode(body.map((r) => r.ind));
    // 有些檔案每行之間都空一行(雙倍行距):空一行不算分段，空兩行以上才算
    let gaps = 0;
    rows.forEach((r, i) => { if (r.t && rows[i + 1] && !rows[i + 1].t && rows[i + 2] && rows[i + 2].t) gaps++; });
    const double = gaps > rows.filter((r) => r.t).length * 0.5;
    const END = /[。，、！？；：」』”’…—）)!?.,]$/;
    const isHead = (r, pb, nb) => (HEAD_RE.test(r.t) && r.t.length < 40 && !/[，。．；]/.test(r.t)) ||
      (bodyInd >= 2 && r.ind < bodyInd && r.t.length <= 24 && !END.test(r.t) && pb && nb);  // 縮排比內文少的短行 = 篇名
    const paras = [];
    let cur = "", full = false, blanks = 1;
    // 太長的段落(分段線索不見了)在句尾切開，每段約 250 字內
    const flush = () => {
      if (cur.length > 350) {
        let buf = "";
        for (const s of cur.match(/[^。．！？]+[。．！？]*[」』”’]?/g) || [cur]) {
          if (buf && buf.length + s.length > 250) { paras.push(buf); buf = ""; }
          buf += s;
        }
        if (buf) paras.push(buf);
      } else if (cur) paras.push(cur);
      cur = ""; full = false;
    };
    rows.forEach((r, i) => {
      if (!r.t) { blanks++; return; }
      if (/^(Produced by|E-?text prepared|This e-?book)/i.test(r.t) || /^[-=_*~·•.。\s]+$/.test(r.t)) { blanks = 0; return; }
      if (isHead(r, blanks > 0, !rows[i + 1] || !rows[i + 1].t)) { flush(); paras.push({ h: r.t }); blanks = 0; return; }
      if (!(cur && full && (blanks === 0 || (double && blanks === 1)))) flush();
      cur += r.t;
      // 段首多縮排兩格，算寬度時要加回來(縮排以半形計，全形空白算 2)
      // 段首行常少兩格；沒以句號結尾、又接近滿寬的行也當成還沒完
      const len = r.t.length + Math.max(0, r.ind - bodyInd) / 2;
      full = wrapped && (len >= width - 2 || (len >= width * 0.75 && !/[。．！？」』”’…：:]$/.test(r.t)));
      if (!wrapped) flush();
      blanks = 0;
    });
    flush();
    let chapters = [], ch = null;
    for (const p of paras) {
      if (p.h) { ch = { title: p.h.replace(/\s+/g, " "), lines: [] }; chapters.push(ch); }
      else { if (!ch) { ch = { title: "開頭", lines: [] }; chapters.push(ch); } ch.lines.push(p); }
    }
    chapters = chapters.filter((c) => c.lines.length);
    // 第一章前面只有一點點字(版權、標題)就丟掉
    if (chapters.length > 1 && chapters[0].title === "開頭" && chapters[0].lines.join("").length < 300) chapters.shift();
    if (chapters.length < 2) {  // 沒有章名：每約 4000 字切一段
      chapters = [];
      let lines = [], n = 0;
      for (const p of paras) {
        if (p.h) continue;
        lines.push(p); n += p.length;
        if (n > 4000) { chapters.push({ title: `第 ${chapters.length + 1} 段`, lines }); lines = []; n = 0; }
      }
      if (lines.length) chapters.push({ title: `第 ${chapters.length + 1} 段`, lines });
    }
    if (!chapters.length) throw new Error("檔案裡沒有文字");
    return chapters;
  }

  // TXT:先試 UTF-8,不是的話在 GBK(簡體)和 Big5(繁體)之間挑常用字比較多的
  async function importTxt(file) {
    const buf = await file.arrayBuffer();
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); }
    catch (e) {
      const score = (t) => (t.match(/[的了是不我一他你這这在有說说]/g) || []).length - (t.match(/�/g) || []).length * 5;
      const g = new TextDecoder("gbk").decode(buf), b = new TextDecoder("big5").decode(buf);
      text = score(g) >= score(b) ? g : b;
    }
    const id = await hashId("txt:" + file.name + ":" + buf.byteLength);
    return saveBook(id, file.name.replace(/\.txt$/i, ""), textToChapters(text), { src: "TXT", file: file.name });
  }

  // ---------- 免費書庫：古騰堡計畫(Project Gutenberg)中文公版書，經自己的雲端代抓 ----------
  const GUTEN = "https://www.gutenberg.org";
  async function gutenSearch(q, start) {
    const url = `${GUTEN}/ebooks/search.opds/?query=${encodeURIComponent(("l.zh " + q).trim())}` + (start ? `&start_index=${start}` : "");
    const xml = new DOMParser().parseFromString(await fetchHTML(url), "application/xml");
    const books = [...xml.getElementsByTagName("entry")].map((e) => {
      const m = (e.getElementsByTagName("id")[0] || {}).textContent.match(/ebooks\/(\d+)\.opds/);
      return m && {
        id: m[1],
        title: toTrad([(e.getElementsByTagName("title")[0] || {}).textContent.replace(/\s*\((Chinese|English)\)\s*$/, "").trim()])[0],
        author: ((e.getElementsByTagName("content")[0] || {}).textContent || "").trim(),
      };
    }).filter(Boolean);
    const next = [...xml.getElementsByTagName("link")].some((l) => l.getAttribute("rel") === "next");
    return { books, next };
  }
  async function gutenAdd(g) {
    let text = await fetchHTML(`${GUTEN}/cache/epub/${g.id}/pg${g.id}.txt`);
    const s = text.search(/\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG[^\n]*\n/), e = text.search(/\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG/);
    if (s >= 0) text = text.slice(text.indexOf("\n", s) + 1, e > s ? e : undefined);
    const id = await hashId("gutenberg:" + g.id);
    const url = await saveBook(id, g.title, textToChapters(text), { src: "古騰堡", author: g.author });
    const got = store.get("guten", {}); got[g.id] = url; store.set("guten", got);
    return url;
  }
  function showLibrary() {
    const got = store.get("guten", {});
    const row = (b) => `<li><span class="gl-t">${esc(b.title)}<span class="gl-a">${esc(b.author)}</span></span>
      <button data-gadd='${esc(JSON.stringify(b))}' ${got[b.id] ? "disabled" : ""}>${got[b.id] ? "✓ 已加入" : "加入"}</button></li>`;
    openSheet(`
      <h2 style="font-family:var(--sans);font-size:20px">免費書庫</h2>
      <p class="sub">古騰堡計畫(Project Gutenberg)的中文公版書：免費、合法，整本下載到手機，之後離線也能讀。多是古典小說(紅樓夢、西遊記、魯迅…),現代小說請用網址或 EPUB。</p>
      <form class="add" id="gForm" style="margin-top:10px"><input id="gQ" type="search" placeholder="搜尋書名或作者" autocomplete="off"><button>搜尋</button></form>
      <ul class="list" id="gList"><li class="sub">讀取中…</li></ul>`);
    let q = "", start = 0;
    const run = async (more) => {
      const list = $("gList");
      if (!more) { start = 1; list.innerHTML = `<li class="sub">讀取中…</li>`; }
      try {
        const r = await gutenSearch(q, more ? start : 0);
        if (!$("gList")) return;
        if (!more) list.innerHTML = "";
        const old = list.querySelector("[data-gmore]"); if (old) old.closest("li").remove();
        list.insertAdjacentHTML("beforeend", r.books.map(row).join("") || `<li class="sub">找不到。古騰堡的中文書不多，可以換關鍵字(有些書名是簡體或拼音)。</li>`);
        start += 25;
        if (r.next) list.insertAdjacentHTML("beforeend", `<li><button data-gmore="1" style="flex:1;height:40px">載入更多</button></li>`);
      } catch (e) { list.innerHTML = errHtml(e.message || String(e)); }
    };
    $("gForm").onsubmit = (e) => { e.preventDefault(); q = $("gQ").value.trim(); run(false); };
    $("gList").onclick = async (e) => {
      if (e.target.closest("[data-gmore]")) { run(true); return; }
      const b = e.target.closest("[data-gadd]");
      if (!b || b.disabled) return;
      b.disabled = true; b.textContent = "下載中…";
      try { await gutenAdd(JSON.parse(b.dataset.gadd)); b.textContent = "✓ 已加入"; showHome(); }
      catch (err) { b.disabled = false; b.textContent = "重試"; alert(err.message || String(err)); }
    };
    run(false);
  }

  // ---------- 書架與每本書的單字統計(存在這支手機) ----------
  // 一段文字裡出現的所有英文候選(不受每章上限限制),用來算「可學單字」
  function wordsIn(lines) {
    const index = VOCAB.index, out = new Set();
    for (const line of lines) {
      let i = 0;
      while (i < line.length) {
        let hit = 0;
        for (const n of [6, 5, 4, 3, 2]) {
          const t = line.substr(i, n);
          if (t.length === n && Object.prototype.hasOwnProperty.call(index, t)) { index[t].forEach((en) => out.add(en)); hit = n; break; }
        }
        i += hit || 1;
      }
    }
    return out;
  }

  function shelfRecord(ch) {
    const id = bookId(ch.url);
    const s = store.get("shelf", {});
    const old = s[id] || {};
    // 保留來源、作者、貼上標記；開始讀了就不再是「還沒開始讀」
    const e = { src: old.src, author: old.author, paste: old.paste, book: ch.book, title: ch.title, url: ch.url, at: Math.floor(Date.now() / 1000) };
    const m = ch.url.match(/^epub:\/\/[0-9a-f]{12}\/(\d+)$/);
    if (m) { e.idx = +m[1]; e.total = ch.total; }
    s[id] = e;
    store.set("shelf", s);
    // 讀過的章節、遇到的單字
    const chs = new Set(store.get("bc:" + id, []));
    chs.add(ch.url);
    store.set("bc:" + id, [...chs]);
    if (!m) {
      const ws = new Set(store.get("bw:" + id, []));
      ch.words.forEach((w) => w.cands.forEach((c) => ws.add(c.en)));
      store.set("bw:" + id, [...ws]);
    }
  }

  function bookStats(id) {
    const ws = store.get("bw:" + id, []);
    // 學過 = 讀的時候真的換成英文出現過的字(bs);舊資料沒有 bs,網站書就用遇過的字
    const bs = store.get("bs:" + id, null) || (id.startsWith("epub-") ? [] : ws);
    return { words: ws.length, known: ws.filter((w) => known.has(w)).length, read: store.get("bc:" + id, []).length, learned: bs };
  }
  // 記下這章實際換成英文的字
  function recordShown(words) {
    if (!chap) return;
    const id = bookId(chap.url), key = "bs:" + id;
    const bs = new Set(store.get(key, null) || (id.startsWith("epub-") ? [] : store.get("bw:" + id, [])));
    const n = bs.size;
    words.forEach((w) => activeCands(w).forEach((c) => bs.add(c.en)));
    if (bs.size !== n) store.set(key, [...bs]);
    logDay(chap.book, bs.size - n);
  }
  // 借書卡：每天一列 {日期: {b: 最後讀的書, n: 當天新學字數}},留最近 60 天
  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function logDay(book, added) {
    const log = store.get("log", {}), d = today(), e = log[d] || { b: "", n: 0 };
    if (e.b === book && !added) return;
    log[d] = { b: book || e.b, n: e.n + Math.max(0, added) };
    const keys = Object.keys(log).sort();
    keys.slice(0, Math.max(0, keys.length - 60)).forEach((k) => delete log[k]);
    store.set("log", log);
  }
  const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  function loanCard(books, chs) {
    const log = store.get("log", {}), d = today();
    const rows = Object.keys(log).sort().reverse().slice(0, 6).map((k) =>
      `<tr><td><span class="dstamp${k === d ? " r" : ""}">${MON[+k.slice(5, 7) - 1]} ${k.slice(8)}</span></td>
        <td class="lbk">${esc(log[k].b || "")}</td><td>${log[k].n ? "+" + log[k].n : "·"}</td></tr>`);
    while (rows.length < 3) rows.push(`<tr><td></td><td class="lbk"></td><td></td></tr>`);
    return `<section class="lcard">
      <div class="hd"><b>借書卡</b><span>No. ${d.slice(0, 7)}</span></div>
      <table><tr><th style="width:32%">DATE</th><th>書名</th><th style="width:16%">新字</th></tr>${rows.join("")}</table>
      <div class="ft">${books} 本 · ${chs.toLocaleString()} 章 · 已熟 ${known.size.toLocaleString()}</div>
    </section>`;
  }

  // ---------- 發音 ----------
  let voice = null;
  function pickVoice() {
    const vs = speechSynthesis.getVoices().filter((v) => /^en[-_]US/i.test(v.lang));
    voice = vs.find((v) => /Samantha|Google US|Aria|Jenny/i.test(v.name)) || vs[0] || null;
  }
  if ("speechSynthesis" in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
  function speak(text, rate) {
    if (!("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US"; u.rate = rate || 0.9; if (voice) u.voice = voice;
    speechSynthesis.speak(u);
  }

  // ---------- 畫面 ----------
  const activeCands = (w) => w.cands.filter((c) => c.level <= level && !known.has(c.en)).sort((a, b) => b.level - a.level);
  const activeWords = () => (level === 0 ? [] : chap.words.filter((w) => activeCands(w).length));

  // ---------- 記住每一章讀到哪(以段落為錨點，換字級/字體也不會跑掉) ----------
  let loading = false;
  const headH = () => (document.querySelector("header") || {}).offsetHeight || 0;
  const paras = () => $("text").querySelectorAll(":scope > p");
  function readPara() {
    if (!chap || loading || document.body.classList.contains("home")) return null;
    const ps = paras(), top = headH();
    for (let i = 0; i < ps.length; i++) {
      const r = ps[i].getBoundingClientRect();
      if (r.bottom > top + 1) return { p: i, f: Math.max(0, Math.min(1, (top - r.top) / (r.height || 1))) };
    }
    return null;
  }
  function savePos() {
    const a = readPara();
    if (!a) return;
    // 每本書只留最後打開那一章的位置(書架記的就是那一章)
    const keep = new Set(Object.values(store.get("shelf", {})).map((b) => b.url));
    const all = {};
    for (const [u, v] of Object.entries(store.get("pos", {}))) if (keep.has(u)) all[u] = v;
    all[chap.url] = a;
    store.set("pos", all);
  }
  function goPara(a) {
    const el = a && paras()[a.p];
    if (!el) { window.scrollTo(0, 0); return; }
    const r = el.getBoundingClientRect();
    window.scrollTo(0, Math.max(0, window.scrollY + r.top + a.f * r.height - headH()));
  }
  let posT;
  window.addEventListener("scroll", () => { clearTimeout(posT); posT = setTimeout(savePos, 300); }, { passive: true });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") savePos(); });
  window.addEventListener("pagehide", savePos);

  async function load(url) {
    const first = !chap || chap.url !== url;
    if (first) { savePos(); loading = true; $("text").innerHTML = `<p class="sub" style="text-align:center">讀取中…</p>`; }
    try {
      await sites();
      url = await resolveBook(normalize(url));
      const [ch] = await Promise.all([getChapter(url), vocab()]);
      ch.words = localVocab(ch.lines);
      chap = ch;
    } catch (e) {
      loading = false;
      showHome(e.message || String(e));
      return;
    }
    document.body.classList.remove("home");
    setMeta();
    store.set("lastUrl", url);
    shelfRecord(chap);
    history.replaceState(null, "", "?url=" + encodeURIComponent(url));
    loading = false;
    render(!first);
    if (first) {
      const saved = store.get("pos", {})[chap.url];
      goPara(saved);
      // 字型載完版面可能會變，再對一次
      if (saved && document.fonts) document.fonts.ready.then(() => goPara(saved));
    }
    prefetch(chap.next);
  }

  // ---------- 首頁 ----------
  const SVG = {
    search: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>`,
    clip: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="5" y="4.5" width="14" height="17" rx="2.5"/><rect x="8.5" y="2.5" width="7" height="4" rx="1.2" fill="currentColor"/></svg>`,
  };
  // 分類小圖示：色票做的小書
  const mini = (c, c2, extra) => `<svg width="34" height="34" viewBox="0 0 34 34"><rect x="5" y="3" width="24" height="28" rx="3" fill="${c2}"/>
    <rect x="7" y="27" width="20" height="2.6" fill="#fbf7ee"/><rect x="8" y="3" width="21" height="23" rx="2.5" fill="${c}"/>${extra || ""}</svg>`;
  const ICO = {
    epub: mini("#1E459F", "#15336f", `<text x="18.5" y="18" font-size="7" font-weight="700" fill="#fff" text-anchor="middle" font-family="Arial">EPUB</text>`),
    txt: mini("#CF2A2A", "#9c1d1d", `<rect x="12" y="9" width="13" height="2" rx="1" fill="#fff"/><rect x="12" y="13.5" width="13" height="2" rx="1" fill="#fff"/><rect x="12" y="18" width="8" height="2" rx="1" fill="#fff"/>`),
    paste: mini("#FABD32", "#d59a14", `<path d="M13 16.5l3.5 3.5 6-7" stroke="#1E459F" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`),
    lib: `<svg width="34" height="34" viewBox="0 0 34 34"><rect x="4" y="8" width="7" height="22" rx="1.5" fill="#1E459F"/><rect x="12" y="5" width="7" height="25" rx="1.5" fill="#CF2A2A"/>
      <rect x="20.5" y="9" width="7" height="21" rx="1.5" fill="#FABD32" transform="rotate(-10 24 20)"/><rect x="3" y="29.5" width="28" height="2.5" rx="1" fill="#E1DCCA"/></svg>`,
    site: mini("#3d6bd1", "#1E459F", `<circle cx="18.5" cy="14.5" r="6" stroke="#fff" stroke-width="1.8" fill="none"/><path d="M12.5 14.5h12M18.5 8.5c-3 4-3 8 0 12c3-4 3-8 0-12" stroke="#fff" stroke-width="1.4" fill="none"/>`),
  };
  // 預設書封顏色(昭和喫茶色票):[封面, 封底, 字色, 書籤]
  const COVERS = [
    ["#2F4A3A", "#1f3328", "#F4E4C1", "#A8402E"], ["#A8402E", "#7d2e20", "#F4E4C1", "#2F4A3A"],
    ["#8B5E3C", "#6B4429", "#F4E4C1", "#A8402E"], ["#3B4F6B", "#2a3a50", "#F4E4C1", "#C9A24A"],
    ["#C9A24A", "#a3812f", "#3B2A1E", "#A8402E"], ["#5B3A4A", "#40283a", "#F4E4C1", "#C9A24A"],
  ];
  function coverOf(s) { let h = 0; for (const c of s) h = (h * 31 + c.codePointAt(0)) >>> 0; return COVERS[h % COVERS.length]; }

  function setMeta() {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue(document.body.classList.contains("home") ? "--h-bg" : "--bg").trim() || "#faf7f0";
  }

  const isUrl = (v) => /^(https?:)?\/\//i.test(v) || /^epub:\/\//.test(v) || /^[\w-]+(\.[\w-]+)+\//.test(v);

  async function showHome(err) {
    savePos();
    chap = null;
    await sites().catch(() => {});
    document.body.classList.add("home");
    setMeta();
    const shelf = store.get("shelf", {});
    const ids = Object.keys(shelf);
    const learned = new Set();
    let chs = 0;
    ids.forEach((id) => { const st = bookStats(id); st.learned.forEach((w) => learned.add(w)); chs += st.read; });
    const shortName = (x) => x.name.split(/\s+/)[0];
    const czb = SITES.find((x) => x.host === "czbooks.net");
    $("text").innerHTML = `
      <section class="h-top">
        <div class="pm" aria-label="已學 ${learned.size} 個單字，已熟 ${known.size}">
          <div class="pm-ring"><span>已學</span><b>${learned.size.toLocaleString()}</b><span>WORDS</span><span>${today().slice(5).replace("-", ".")}</span></div>
          <svg viewBox="0 0 70 34" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M0 5q6-5 12 0t12 0 12 0 12 0 12 0 12 0"/><path d="M0 17q6-5 12 0t12 0 12 0 12 0 12 0 12 0"/><path d="M0 29q6-5 12 0t12 0 12 0 12 0 12 0 12 0"/></svg>
          <span class="pm-k">已熟 ${known.size.toLocaleString()}</span>
        </div>
        <button class="h-round" type="button" data-settings aria-label="閱讀設定">Aa</button>
      </section>
      <form id="urlForm" class="h-search">
        <div class="pill">
          <input id="urlIn" type="text" inputmode="url" enterkeyhint="go" autocomplete="off" placeholder="${czb ? "貼上小說網址，或搜尋書名" : "貼上小說網址"}">
          <button type="button" class="h-clip" id="btnClip" aria-label="從剪貼簿貼上">${SVG.clip}</button>
        </div>
        <button class="h-go" aria-label="開始">${SVG.search}</button>
      </form>
      ${err ? errHtml(err) : ""}
      <div class="h-cats">
        <label class="h-cat"><span class="ico">${ICO.epub}</span>EPUB<input id="epubIn" type="file" accept=".epub,application/epub+zip" hidden></label>
        <label class="h-cat"><span class="ico">${ICO.txt}</span>TXT<input id="txtIn" type="file" accept=".txt,text/plain" hidden></label>
        <button type="button" class="h-cat" id="btnPaste"><span class="ico">${ICO.paste}</span>貼上文字</button>
        <button type="button" class="h-cat" data-lib><span class="ico">${ICO.lib}</span>免費書庫</button>
        ${SITES.map((x) => x.cloudBlocked
          ? `<a class="h-cat off" href="${esc(x.home || "https://" + x.host + "/")}" target="_blank" rel="noopener"><span class="ico">${ICO.site}</span>${esc(shortName(x))} ↗</a>`
          : `<button type="button" class="h-cat" data-browse="${esc(x.home || "https://" + x.host + "/")}"><span class="ico">${ICO.site}</span>${esc(shortName(x))}</button>`).join("")}
      </div>
      <p class="sub" id="epubMsg"></p>
      ${renderShelf(shelf)}
      ${ids.length ? loanCard(ids.length, chs) : ""}
      <p class="foot">網址支援:${SITES.filter((x) => !x.cloudBlocked).map((x) => esc(x.name)).join("、") || "czbooks.net"}${SITES.some((x) => x.cloudBlocked)
        ? `;${SITES.filter((x) => x.cloudBlocked).map((x) => esc(shortName(x))).join("、")}擋雲端抓取，請複製章節用「貼上文字」` : ""}。EPUB、TXT 和免費書庫的書整本存在這支手機。簡體自動轉繁體；單字從多益/托福/雅思字表對照，不用 AI。</p>`;

    const busy = async (f, fn) => {
      if (!f) return;
      $("epubMsg").textContent = `處理中…(${(f.size / 1048576).toFixed(1)} MB)`;
      try { await fn(f); } catch (err) { $("epubMsg").textContent = err.message || "檔案讀不了"; }
    };
    $("epubIn").onchange = (e) => busy(e.target.files[0], async (f) => load(await importEpub(f)));
    $("txtIn").onchange = (e) => busy(e.target.files[0], async (f) => { await importTxt(f); showHome(); });
    $("urlForm").onsubmit = (e) => {
      e.preventDefault();
      const v = $("urlIn").value.trim();
      if (!v) return;
      if (isUrl(v)) load(/^[\w-]+(\.[\w-]+)+\//.test(v) ? "https://" + v : v);
      else if (czb) { browse.stack = []; browse.url = ""; showBrowse("https://czbooks.net/s/" + encodeURIComponent(v)); }
      else showHome("請貼上完整的小說網址");
    };
    $("btnPaste").onclick = showPaste;
    $("btnClip").onclick = async () => {
      try {
        const t = (await navigator.clipboard.readText()).trim();
        const m = t.match(/https?:\/\/\S+/);
        if (m) { $("urlIn").value = m[0]; load(m[0]); } else { $("urlIn").value = t; $("urlIn").focus(); }
      } catch (e) { $("urlIn").focus(); }
    };
    applyBw();
    fillShelf();
  }

  // ---------- 書架：立體書，可左右滑；兩指捏合縮放(放大=一排滑動，縮小=格狀看更多本) ----------
  function renderShelf(shelf) {
    const books = Object.entries(shelf).map(([id, b]) => ({ id, ...b })).sort((a, b) => b.at - a.at);
    if (!books.length) {
      return `<div class="h-sec"><h2>我的書架</h2></div>
        <div class="h-empty">書架還是空的。<br>從上面匯入 EPUB / TXT、到免費書庫挑一本，<br>或貼上小說網址開始讀。</div>`;
    }
    const siteName = (url) => { try { const s = siteOf(new URL(url).hostname); return s ? s.name.split(/\s+/)[0] : new URL(url).hostname; } catch (e) { return ""; } };
    return `
      <div class="h-sec"><h2>我的書架<small>${books.length}</small></h2>
        <div class="h-tools">
          <button type="button" data-zoom="-1" aria-label="縮小，看更多本">−</button>
          <button type="button" data-zoom="1" aria-label="放大">＋</button>
          <button type="button" class="arr" data-scroll="-1" aria-label="往左">‹</button>
          <button type="button" class="arr" data-scroll="1" aria-label="往右">›</button>
        </div></div>
      <div class="h-shelf" id="shelf">${books.map((b) => {
        const st = bookStats(b.id);
        const name = b.book || "未命名";
        const isEpub = b.url.startsWith("epub");
        const [c, , fc] = coverOf(name);
        const vert = /^[\u3400-\u9fff，、。！？：·\s]+$/.test(name) && name.length <= 10;  // 中文短書名直排
        const src = b.author || b.src || (isEpub ? (b.paste ? "貼上文字" : "EPUB") : siteName(b.url));
        const pct = isEpub && b.total ? (b.fresh ? 0 : Math.round((b.idx / b.total) * 100)) : null;
        const prog = pct !== null ? `${pct}%` : b.fresh ? "還沒開始" : `第 ${st.read} 章`;
        return `
        <article class="h-book" data-open="${esc(b.url)}" data-id="${esc(b.id)}">
          <div class="stw"><div class="b3d" style="--c:${c};--fc:${fc}">
            <div class="b3d-front${vert ? " v" : ""}"><div class="b3d-title${/[a-z]/i.test(name) && !/[\u3400-\u9fff]/.test(name) ? " en" : ""}">${esc(name)}</div></div>
            <i class="exlib">EX LIBRIS</i>
          </div><i class="plank"></i></div>
          <div class="h-name">${esc(name)}</div>
          <div class="h-src">${esc(src)}</div>
          <div class="h-prog"><div class="bar"><i style="width:${pct || 0}%"></i></div><span>${prog}</span></div>
          <div class="h-meta">學了 <b>${st.learned.length.toLocaleString()}</b> 字${st.known ? ` · 熟 ${st.known}` : ""}</div>
          <button type="button" class="h-more" data-menu="${esc(b.id)}" aria-label="更多">⋯</button>
        </article>`;
      }).join("")}</div>
      <p class="h-tip">兩指捏合縮放書架 · 點 ⋯ 換封面</p>`;
  }

  // 自訂書封、網站書的進度(從存好的目錄算)晚一點補上
  function fillShelf() {
    const shelf = store.get("shelf", {});
    document.querySelectorAll(".h-book[data-id]").forEach((el) => {
      const id = el.dataset.id, b = shelf[id];
      idbGet("covers", id).then((url) => {
        if (url) el.querySelector(".b3d-front").insertAdjacentHTML("afterbegin", `<img src="${url}" alt="">`);
      }).catch(() => {});
      if (!b || b.url.startsWith("epub") || b.fresh) return;
      idbGet("chapters", "toc:" + id).then((t) => {
        const i = t ? t.list.findIndex((x) => x.u === b.url) : -1;
        if (i < 0) return;
        const pct = Math.round(((i + 1) / t.list.length) * 100);
        el.querySelector(".h-prog i").style.width = pct + "%";
        el.querySelector(".h-prog span").textContent = `${pct}%`;
      }).catch(() => {});
    });
  }

  let shelfW = store.get("shelfW", 150);
  const ZOOMS = [72, 92, 110, 150, 190];
  function applyBw() {
    const el = $("shelf");
    if (!el) return;
    el.style.setProperty("--bw", shelfW + "px");
    const car = shelfW >= 125;
    el.classList.toggle("carousel", car);
    el.classList.toggle("tiny", shelfW < 96);
    document.querySelectorAll(".h-tools .arr").forEach((b) => (b.hidden = !car));
  }
  function setBw(v, save) {
    shelfW = Math.round(Math.max(64, Math.min(200, v)));
    applyBw();
    if (save) store.set("shelfW", shelfW);
  }
  const homeOpen = () => document.body.classList.contains("home") && $("shelf") && !$("sheet").classList.contains("open");
  let pinch = null;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  document.addEventListener("touchstart", (e) => { if (e.touches.length === 2 && homeOpen()) pinch = { d: dist(e.touches), w: shelfW }; }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (pinch && e.touches.length === 2) { e.preventDefault(); setBw(pinch.w * dist(e.touches) / pinch.d); }
  }, { passive: false });
  document.addEventListener("touchend", (e) => { if (pinch && e.touches.length < 2) { pinch = null; setBw(shelfW, true); } });
  document.addEventListener("gesturestart", (e) => { if (homeOpen()) e.preventDefault(); });  // iOS:不要放大整頁
  document.addEventListener("wheel", (e) => {  // 電腦觸控板捏合 = ctrl + 滾輪
    if (e.ctrlKey && homeOpen()) { e.preventDefault(); setBw(shelfW * (1 - e.deltaY * 0.01), true); }
  }, { passive: false });

  function showBookMenu(id) {
    const b = store.get("shelf", {})[id];
    if (!b) return;
    idbGet("covers", id).catch(() => null).then((cv) => openSheet(`
      <h2 style="font-family:var(--sans);font-size:20px">${esc(b.book || "未命名")}</h2>
      <div class="btns" style="flex-direction:column">
        <button data-cover="${esc(id)}">🖼️ 換封面(從相簿選圖片)</button>
        ${cv ? `<button data-uncover="${esc(id)}">還原預設封面</button>` : ""}
        <button data-del="${esc(id)}" style="color:var(--h-red)">從書架移除</button>
      </div>`));
  }
  // 圖片裁成 3:4、縮到 360×480 存在手機(IndexedDB)
  $("coverIn").onchange = async (e) => {
    const f = e.target.files[0], id = e.target.dataset.id;
    e.target.value = "";
    if (!f || !id) return;
    try {
      const img = await createImageBitmap(f);
      const W = 360, H = 480, cv = document.createElement("canvas");
      cv.width = W; cv.height = H;
      const r = Math.max(W / img.width, H / img.height), w = img.width * r, h = img.height * r;
      cv.getContext("2d").drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
      await idbPut("covers", id, cv.toDataURL("image/jpeg", 0.85));
      closeSheet(); showHome();
    } catch (err) { alert("這張圖片讀不了"); }
  };
  function removeBook(id) {
    const s = store.get("shelf", {}), b = s[id];
    delete s[id]; store.set("shelf", s);
    try { ["bw:", "bc:", "bs:"].forEach((p) => localStorage.removeItem("eread:" + p + id)); } catch (err) { /* ignore */ }
    idbDel("covers", id).catch(() => {});
    const g = store.get("guten", {});
    for (const k of Object.keys(g)) if (b && g[k] === b.url) delete g[k];
    store.set("guten", g);
  }

  // ---------- 在 App 裡逛小說網站(透過自己的雲端抓原網頁、原樣顯示),右下角浮動按鈕加入書庫 ----------
  // 不能直接 iframe 原網站(對方禁止嵌入),也不能在 Safari 裡加(主畫面 App 和 Safari 資料分開)
  const czId = (url) => (((new URL(url)).pathname).match(/^\/n\/([^/?#]+)/) || [])[1];
  const inShelf = (id) => !!store.get("shelf", {})["czbooks.net:" + id];
  function addToShelf(id, book) {
    const key = "czbooks.net:" + id, s = store.get("shelf", {});
    if (!s[key]) { s[key] = { book: toTrad([book])[0], title: "", fresh: true, url: "https://czbooks.net/n/" + id, at: Math.floor(Date.now() / 1000) }; store.set("shelf", s); }
  }
  const browse = { stack: [], url: "", book: "" };

  async function showBrowse(url, push) {
    const v = $("browser"), fr = $("brFrame");
    v.hidden = false; document.body.classList.add("browsing");
    if (push !== false && browse.url) browse.stack.push(browse.url);
    browse.url = url; browse.book = "";
    $("brTitle").textContent = "讀取中…"; updateFab();
    let page;
    try { await sites(); page = await fetchHTML(url); }
    catch (e) { $("browser").hidden = true; document.body.classList.remove("browsing"); browse.stack = []; browse.url = ""; showHome(e.message); return; }
    const doc = new DOMParser().parseFromString(page, "text/html");
    doc.querySelectorAll("script,noscript,iframe,ins,object,embed,meta[http-equiv]").forEach((e) => e.remove());
    // 原網站的程式碼一律不執行(CSP),點擊由 App 自己接手
    const csp = doc.createElement("meta"); csp.httpEquiv = "Content-Security-Policy"; csp.content = "script-src 'none'; object-src 'none'; frame-src 'none'"; doc.head.prepend(csp);
    doc.querySelectorAll("*").forEach((e) => [...e.attributes].forEach((at) => { if (/^on/i.test(at.name)) e.removeAttribute(at.name); }));
    const base = doc.createElement("base"); base.href = url; doc.head.prepend(base);
    // 原網站的搜尋視窗靠 JS 開關，這裡用 class 代替
    const st = doc.createElement("style");
    st.textContent = "html.sr-open .site-search-dialog,html.sr-open .search-container{display:block!important;opacity:1!important;visibility:visible!important;transform:none!important;pointer-events:auto!important}body{padding-bottom:90px!important}";
    doc.head.append(st);
    const h = doc.querySelector("h1.title, h1.name");
    const m = (h ? h.textContent : doc.title).match(/《(.+?)》/);
    browse.book = m ? m[1].trim() : (h ? h.textContent.trim() : "");
    $("brTitle").textContent = toTrad([browse.book || doc.title.replace(/\s*\|.*$/, "")])[0];
    fr.onload = () => {
      const d = fr.contentDocument; if (!d) return;
      d.addEventListener("click", (e) => {
        if (e.target.closest(".site-search-trigger, .search-bar")) { e.preventDefault(); d.documentElement.classList.add("sr-open"); const i = d.querySelector("#search-text"); if (i) i.focus(); return; }
        if (e.target.closest(".search-close, .site-search-shadow")) { e.preventDefault(); d.documentElement.classList.remove("sr-open"); return; }
        const kw = e.target.closest(".keywords .item button");
        if (kw) { showBrowse("https://czbooks.net/s/" + encodeURIComponent(kw.textContent.trim())); return; }
        const a = e.target.closest("a[href]"); if (!a) return;
        const href = a.getAttribute("href");
        if (!href || href.startsWith("#") || href.startsWith("javascript")) { e.preventDefault(); return; }
        e.preventDefault();
        let u; try { u = new URL(href, url); } catch (err) { return; }
        if (siteOf(u.hostname)) showBrowse("https://" + siteOf(u.hostname).host + u.pathname + u.search);
      });
      d.addEventListener("submit", (e) => {
        e.preventDefault();
        const q = (e.target.querySelector("input[type=search],input[type=text]") || {}).value;
        if (q && q.trim()) showBrowse("https://czbooks.net/s/" + encodeURIComponent(q.trim()));
      });
    };
    fr.srcdoc = "<!doctype html>" + doc.documentElement.outerHTML;
    updateFab();
  }

  function updateFab() {
    const id = browse.url && czId(browse.url), fab = $("brAdd");
    fab.hidden = !id;
    if (!id) return;
    const have = inShelf(id);
    fab.textContent = have ? "✓ 已在書庫" : "＋ 加入書庫";
    fab.classList.toggle("done", have);
    $("brRead").hidden = !/\/n\/[^/]+\/[^/?]+/.test(new URL(browse.url).pathname);
  }

  function closeBrowse() { $("browser").hidden = true; document.body.classList.remove("browsing"); $("brFrame").srcdoc = ""; browse.stack = []; browse.url = ""; showHome(); }
  $("brBack").onclick = () => { browse.stack.length ? showBrowse(browse.stack.pop(), false) : closeBrowse(); };
  $("brClose").onclick = closeBrowse;
  $("brAdd").onclick = () => {
    const id = czId(browse.url); if (!id || inShelf(id)) return;
    addToShelf(id, browse.book || id); updateFab();
  };
  $("brRead").onclick = () => { const u = browse.url; $("browser").hidden = true; document.body.classList.remove("browsing"); $("brFrame").srcdoc = ""; browse.stack = []; browse.url = ""; load(u); };

  function render(keep = true) {
    if (!chap) return;
    const anchor = keep ? readPara() : null;
    $("bookTitle").textContent = chap.book;
    $("chapTitle").textContent = chap.title;
    const words = activeWords().sort((a, b) => b.zh.length - a.zh.length);
    recordShown(words);
    const byZh = new Map(words.map((w) => [w.zh, w]));
    const re = words.length ? new RegExp("(" + words.map((w) => reEsc(w.zh)).join("|") + ")", "g") : null;
    const seen = new Map();
    const html = chap.lines.map((line) => {
      if (!re) return `<p>${esc(line)}</p>`;
      return "<p>" + line.split(re).map((seg) => {
        const w = byZh.get(seg);
        if (!w) return esc(seg);
        const cs = activeCands(w), k = seen.get(w.zh) || 0;
        seen.set(w.zh, k + 1);
        const c = cs[k % cs.length];
        return `<span class="w" data-zh="${esc(w.zh)}" data-en="${esc(c.en)}">${esc(c.en)}</span>`;
      }).join("") + "</p>";
    }).join("");
    const nav = `<div class="seg" style="margin-top:28px">
      <button data-go="${esc(chap.prev || "")}" ${chap.prev ? "" : "disabled"}>‹ 上一章</button>
      <button data-toc="1">目錄</button>
      ${!chap.next && chap.srcNext
        ? `<a class="srcnext" href="${esc(chap.srcNext)}" target="_blank" rel="noopener">到原網站開下一章 ↗</a>`
        : `<button data-go="${esc(chap.next || "")}" ${chap.next ? "" : "disabled"}>下一章 ›</button>`}</div>`;
    const src = chap.url.startsWith("epub")
      ? chap.src
        ? `<div class="src">原文出處:<a href="${esc(chap.src)}" target="_blank" rel="noopener">${esc(chap.src)}</a><br>僅供個人學習</div>`
        : `<div class="src">EPUB · 僅供個人學習</div>`
      : `<div class="src">原文出處:<a href="${esc(chap.url)}" target="_blank" rel="noopener">${esc(chap.url)}</a><br>僅供個人學習</div>`;
    $("text").innerHTML = html + nav + src;
    if (anchor) goPara(anchor);
    const occ = words.reduce((n, w) => n + w.count, 0);
    $("lvName").textContent = LV_NAMES[level];
    $("lvStat").textContent = level === 0 ? "不換字" : `${words.length} 字 · 出現 ${occ} 次`;
  }

  function openSheet(html) { $("sheetBody").innerHTML = html; $("sheet").classList.add("open"); $("scrim").style.display = "block"; }
  function closeSheet() {
    $("sheet").classList.remove("open"); $("scrim").style.display = "none";
    document.querySelectorAll(".w.on").forEach((e) => e.classList.remove("on"));
  }

  function levelText(w) {
    const tags = (w.exams || []).filter((x) => x !== "精選");
    return `Lv${w.level} · ${LV_DESC[w.level] || ""}` + (tags.length ? `(${tags.join("、")})` : "");
  }

  function showWord(w, en) {
    const c = w.cands.find((x) => x.en === en) || w.cands[0];
    const others = w.cands.filter((x) => x !== c);
    openSheet(`
      <h2>${esc(c.en)}</h2>
      <div class="ipa">${c.kk ? `KK [${esc(c.kk)}]` : c.ipa ? `/${esc(c.ipa)}/` : ""}</div>
      ${c.mnem ? `<div class="kv"><span>諧音</span>${esc(c.mnem)}</div>` : ""}
      <div class="kv"><span>中文</span>${esc(c.gloss)}</div>
      <div class="kv"><span>原文</span>${esc(w.zh)}</div>
      <div class="kv"><span>等級</span>${esc(levelText(c))}</div>
      <div class="kv"><span>本章</span>出現 ${w.count} 次</div>
      ${c.co && c.co.length ? `<div class="mini-h">常用搭配</div>
      <table class="mini">${c.co.map(([e, z]) =>
        `<tr><td class="col" data-say="${esc(e)}">${esc(e)}</td><td>${esc(z)}</td></tr>`).join("")}</table>` : ""}
      ${others.length ? `<div class="mini-h">同義字</div>
      <table class="mini">${others.map((x) =>
        `<tr><td class="col" data-say="${esc(x.en)}">${esc(x.en)}</td><td>${esc(x.gloss)}</td><td class="lv">Lv${x.level}</td></tr>`).join("")}</table>` : ""}
      <div class="btns">
        <button data-say="${esc(c.en)}">🔊 再聽一次</button>
        <button class="primary" data-known="${esc(c.en)}">✓ 已熟，不再換</button>
      </div>`);
    speak(c.en);
  }

  function showWordbook() {
    if (!chap) return;
    const items = chap.words.flatMap((w) => w.cands.filter((c) => c.level <= Math.max(level, 1)).map((c) => ({ ...c, zh: w.zh })));
    openSheet(`
      <h2 style="font-family:var(--sans);font-size:20px">本章生字本</h2>
      <p class="sub">顯示到目前密度為止的字。點英文發音，標「已熟」的字會改回中文。</p>
      <ul class="list">${items.map((w) => `
        <li class="${known.has(w.en) ? "k" : ""}">
          <span class="en" data-say="${esc(w.en)}">${esc(w.en)}</span>
          <span class="zh">${esc(w.zh)} · ${esc(w.gloss)} · Lv${w.level}</span>
          <button data-toggle="${esc(w.en)}">${known.has(w.en) ? "取消已熟" : "已熟"}</button>
        </li>`).join("")}</ul>`);
  }

  // 外觀選項：英文字顏色(淺色/深色背景各一組)、內文字體、英文字體、行距
  const WORD_COLORS = {
    theme: ["跟主題", null, null],
    red: ["磚紅", "#b4532a", "#f0956a"],
    blue: ["藍", "#2b62b8", "#7fb0ff"],
    green: ["綠", "#2f7a3a", "#7fd08a"],
    purple: ["紫", "#7a3fb0", "#c39bf0"],
    pink: ["粉", "#c23b72", "#f59ac0"],
  };
  const BODY_FONTS = {
    serif: ["明體", 'var(--serif)'],
    sans: ["黑體", 'var(--sans)'],
    kai: ["文楷", '"LXGW WenKai TC", "Kaiti TC", "STKaiti", var(--serif)'],
  };
  const EN_FONTS = {
    type: ["打字機", '"Courier Prime", "Courier New", monospace', "normal", 700],
    serif: ["襯線斜體", 'Georgia, "Times New Roman", serif', "italic"],
    serifUp: ["襯線正體", 'Georgia, "Times New Roman", serif', "normal"],
    sans: ["無襯線", '-apple-system, "Helvetica Neue", Arial, sans-serif', "normal"],
  };
  let wordColor = store.get("wordColor", "theme");
  let bodyFont = store.get("bodyFont", "serif");
  let enFont = store.get("enFont", "type");
  let lh = store.get("lh", 1.9);

  function showSettings() {
    const t = theme || "auto";
    const seg = (key, cur, items) => `<div class="seg">${items.map(([k, label]) =>
      `<button data-set="${key}" data-val="${k}" class="${String(k) === String(cur) ? "on" : ""}">${label}</button>`).join("")}</div>`;
    openSheet(`
      <h2 style="font-family:var(--sans);font-size:20px">閱讀設定</h2>
      <p class="sub">字級</p>
      ${seg("fs", fs, [16, 19, 22, 25].map((n) => [n, n]))}
      <p class="sub">行距</p>
      ${seg("lh", lh, [[1.6, "緊"], [1.9, "中"], [2.2, "鬆"]])}
      <p class="sub">背景主題</p>
      ${seg("theme", t, [["auto", "自動"], ["light", "喫茶"], ["sepia", "米黃"], ["green", "護眼綠"]])}
      ${seg("theme", t, [["dark", "夜間墨綠"], ["black", "純黑"]])}
      <p class="sub">英文字顏色</p>
      <div class="seg">${Object.entries(WORD_COLORS).map(([k, [label, light]]) =>
        `<button data-set="wordColor" data-val="${k}" class="${k === wordColor ? "on" : ""}" style="${light ? `color:${light};font-weight:600` : ""}">${label}</button>`).join("")}</div>
      <p class="sub">中文字體</p>
      ${seg("bodyFont", bodyFont, Object.entries(BODY_FONTS).map(([k, [label]]) => [k, label]))}
      <p class="sub">英文字體</p>
      ${seg("enFont", enFont, Object.entries(EN_FONTS).map(([k, [label]]) => [k, label]))}
      <p class="sub">存取金鑰(抓網路小說用；${store.get("key", "") ? "✓ 已設定" : "尚未設定"})</p>
      <form class="add keyform" style="margin-top:6px"><input name="k" type="password" autocomplete="off" placeholder="貼上存取金鑰"><button>儲存</button></form>
      <p class="sub" style="font-family:var(--body-font);font-size:var(--fs);line-height:var(--lh)">預覽：她<span class="w">suddenly</span>轉過身，嘴角勾起一抹<span class="w">smirk</span>。</p>`);
  }

  function isDark() {
    const t = theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    return t === "dark" || t === "black";
  }

  function applyLook() {
    const root = document.documentElement.style;
    root.setProperty("--fs", fs + "px");
    root.setProperty("--lh", lh);
    if (theme) document.documentElement.setAttribute("data-theme", theme);
    else document.documentElement.removeAttribute("data-theme");
    const wc = WORD_COLORS[wordColor] || WORD_COLORS.theme;
    if (wc[1]) root.setProperty("--word", isDark() ? wc[2] : wc[1]); else root.removeProperty("--word");
    root.setProperty("--body-font", (BODY_FONTS[bodyFont] || BODY_FONTS.serif)[1]);
    const ef = EN_FONTS[enFont] || EN_FONTS.type;
    root.setProperty("--en-font", ef[1]);
    root.setProperty("--en-style", ef[2]);
    root.setProperty("--en-w", ef[3] || 400);
    if (bodyFont === "kai" && !document.getElementById("kaiFont")) {  // 文楷：用到才從 Google Fonts 載入
      const l = document.createElement("link");
      l.id = "kaiFont"; l.rel = "stylesheet";
      l.href = "https://fonts.googleapis.com/css2?family=LXGW+WenKai+TC&display=swap";
      document.head.appendChild(l);
    }
    setMeta();
  }
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyLook);

  // ---------- 事件 ----------
  $("slider").value = level;
  $("slider").addEventListener("input", (e) => { level = +e.target.value; store.set("level", level); render(); });
  $("btnWords").onclick = showWordbook;
  $("btnToc").onclick = () => showToc();
  $("btnAa").onclick = showSettings;
  $("scrim").onclick = closeSheet;
  $("chapTitle").onclick = () => showHome();
  $("bookTitle").onclick = () => showHome();

  $("text").addEventListener("click", (e) => {
    const rm = e.target.closest("[data-remove]");
    if (rm) {
      if (confirm("從書架移除這本書？(單字統計也會一起清掉)")) {
        const id = rm.dataset.remove;
        const s = store.get("shelf", {}); delete s[id]; store.set("shelf", s);
        try { localStorage.removeItem("eread:bw:" + id); localStorage.removeItem("eread:bc:" + id); } catch (err) { /* ignore */ }
        showHome();
      }
      return;
    }
    if (e.target.closest("[data-home]")) { showHome(); return; }
    const mn = e.target.closest("[data-menu]");
    if (mn) { showBookMenu(mn.dataset.menu); return; }
    if (e.target.closest("[data-lib]")) { showLibrary(); return; }
    if (e.target.closest("[data-settings]")) { showSettings(); return; }
    const zm = e.target.closest("[data-zoom]");
    if (zm) {
      const up = +zm.dataset.zoom > 0;
      setBw(up ? ZOOMS.find((z) => z > shelfW + 2) || 200 : [...ZOOMS].reverse().find((z) => z < shelfW - 2) || 64, true);
      return;
    }
    const sc = e.target.closest("[data-scroll]");
    if (sc) { $("shelf").scrollBy({ left: +sc.dataset.scroll * (shelfW + 20) * 2, behavior: "smooth" }); return; }
    const br = e.target.closest("[data-browse]");
    if (br) { browse.stack = []; browse.url = ""; showBrowse(br.dataset.browse); return; }
    const open = e.target.closest("[data-open]");
    if (open) { load(open.dataset.open); return; }
    const go = e.target.closest("[data-go]");
    if (go && go.dataset.go) { load(go.dataset.go); return; }
    if (e.target.closest("[data-toc]")) { showToc(); return; }
    const w = e.target.closest(".w");
    if (w) { w.classList.add("on"); showWord(chap.words.find((x) => x.zh === w.dataset.zh), w.dataset.en); }
  });

  $("sheet").addEventListener("click", (e) => {
    const go = e.target.closest("[data-go]");
    if (go) { closeSheet(); load(go.dataset.go); return; }
    const tj = e.target.closest("[data-tocjump]");
    if (tj) { tocJump(+tj.dataset.tocjump); return; }
    const cv = e.target.closest("[data-cover]");
    if (cv) { $("coverIn").dataset.id = cv.dataset.cover; $("coverIn").click(); return; }
    const uc = e.target.closest("[data-uncover]");
    if (uc) { idbDel("covers", uc.dataset.uncover).then(() => { closeSheet(); showHome(); }); return; }
    const dl = e.target.closest("[data-del]");
    if (dl) {
      if (confirm("從書架移除這本書？(單字統計也會一起清掉)")) { removeBook(dl.dataset.del); closeSheet(); showHome(); }
      return;
    }
    const t = e.target.closest("[data-say],[data-known],[data-toggle],[data-set]");
    if (!t) return;
    if (t.dataset.say) speak(t.dataset.say);
    if (t.dataset.known) { known.add(t.dataset.known); store.set("known", [...known]); closeSheet(); render(); }
    if (t.dataset.toggle) {
      const k = t.dataset.toggle; known.has(k) ? known.delete(k) : known.add(k);
      store.set("known", [...known]); render(); showWordbook();
    }
    if (t.dataset.set) {
      const v = t.dataset.val;
      switch (t.dataset.set) {
        case "fs": fs = +v; store.set("fs", fs); break;
        case "lh": lh = +v; store.set("lh", lh); break;
        case "theme": theme = v === "auto" ? null : v; store.set("theme", theme); break;
        case "wordColor": wordColor = v; store.set("wordColor", v); break;
        case "bodyFont": bodyFont = v; store.set("bodyFont", v); break;
        case "enFont": enFont = v; store.set("enFont", v); break;
      }
      applyLook(); showSettings();
    }
  });

  if ("serviceWorker" in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register("sw.js").catch(() => {});
    // 有新版本裝好時自動重新整理一次，不用手動關掉 App
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController) location.reload(); });
  }
  applyLook();
  const qs = new URLSearchParams(location.search);
  if (qs.get("key")) { store.set("key", qs.get("key")); history.replaceState(null, "", location.pathname); alert("已設定存取金鑰，之後可以直接讀網路小說了。"); }
  sites().catch(() => {});
  const startUrl = qs.get("url") || store.get("lastUrl", "");
  if (qs.get("browse")) { showHome(); showBrowse(qs.get("browse")); }
  else startUrl ? load(startUrl) : showHome();
})();
