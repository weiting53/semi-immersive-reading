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
    const req = indexedDB.open("eread", 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("chapters");
      req.result.createObjectStore("epubs");
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
  function normalize(url) {
    url = url.trim();
    if (url.startsWith("//")) url = "https:" + url;
    if (/^epub:\/\/[0-9a-f]{12}\/\d+$/.test(url)) return url;
    let u;
    try { u = new URL(url); } catch (e) { throw new Error("網址格式不對"); }
    if (/(^|\.)(xbanxia\.cc|xbanxia\.com|banxia\.cc)$/.test(u.hostname)) return "https://www.xbanxia.cc" + u.pathname;
    if (/(^|\.)czbooks\.net$/.test(u.hostname)) return "https://czbooks.net" + u.pathname + u.search;
    throw new Error("目前支援 czbooks.net、半夏小說(xbanxia.cc)和 EPUB");
  }
  function bookId(url) {
    const u = new URL(url.replace(/^epub:/, "https:"));
    if (url.startsWith("epub:")) return "epub-" + u.hostname;
    const m = u.pathname.match(/^\/(?:n|books)\/([^/.]+)/);
    return m ? u.hostname + ":" + m[1] : url;
  }

  // ---------- 抓章節 ----------
  async function fetchHTML(url) {
    const r = await fetch("api/fetch?url=" + encodeURIComponent(url));
    if (r.status === 403 && url.includes("xbanxia")) {
      throw new Error("半夏小說擋掉了雲端抓取，手機版讀不到。可以改用電腦版(server.py,同一個 Wi-Fi),或把書轉成 EPUB 匯入。");
    }
    if (!r.ok) throw new Error(r.status === 404 ? "網站找不到這一頁" : `抓取失敗(${r.status})`);
    return r.text();
  }
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
      return { ...chapterObj(url, lib.book, chs[k - 1].title, chs[k - 1].lines, mk(k - 1), mk(k + 1)), total: chs.length };
    }
    const cached = await idbGet("chapters", url);
    if (cached) return cached;
    const page = await fetchHTML(url);
    const ch = new URL(url).hostname.endsWith("xbanxia.cc") ? parseBanxia(url, page) : parseCzbooks(url, page);
    await idbPut("chapters", url, ch);
    return ch;
  }

  function prefetch(url) {
    if (!url || url.startsWith("epub://")) return;
    idbGet("chapters", url).then((c) => { if (!c) getChapter(url).catch(() => {}); });
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
    const e = { book: ch.book, title: ch.title, url: ch.url, at: Math.floor(Date.now() / 1000) };
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
    return { words: ws.length, known: ws.filter((w) => known.has(w)).length, read: store.get("bc:" + id, []).length };
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

  async function load(url) {
    const first = !chap || chap.url !== url;
    if (first) $("text").innerHTML = `<p class="sub" style="text-align:center">讀取中…</p>`;
    try {
      url = await resolveBook(normalize(url));
      const [ch] = await Promise.all([getChapter(url), vocab()]);
      ch.words = localVocab(ch.lines);
      chap = ch;
    } catch (e) {
      showHome(e.message || String(e));
      return;
    }
    document.body.classList.remove("home");
    store.set("lastUrl", url);
    shelfRecord(chap);
    history.replaceState(null, "", "?url=" + encodeURIComponent(url));
    render();
    if (first) window.scrollTo(0, 0);
    prefetch(chap.next);
  }

  function showHome(err) {
    chap = null;
    document.body.classList.add("home");
    $("bookTitle").textContent = "半沉浸式英語閱讀";
    $("chapTitle").textContent = "貼上網址或匯入 EPUB";
    $("lvStat").textContent = "";
    const last = store.get("lastUrl", "");
    const shelf = store.get("shelf", {});
    const ids = Object.keys(shelf);
    const met = new Set();
    ids.forEach((id) => store.get("bw:" + id, []).forEach((w) => met.add(w)));
    $("text").innerHTML = `
      <section class="hero">
        <h1>半沉浸式英語閱讀</h1>
        <p>讀你想看的小說，順便把英文單字讀進腦袋。</p>
        <div class="stats">
          <div><b>${ids.length}</b><span>本書</span></div>
          <div><b>${met.size.toLocaleString()}</b><span>遇過的單字</span></div>
          <div><b>${known.size.toLocaleString()}</b><span>已熟</span></div>
        </div>
      </section>
      ${err ? `<p class="err">${esc(err)}</p>` : ""}
      <form id="urlForm" class="add">
        <input id="urlIn" type="url" required placeholder="貼 czbooks 章節或書本網址" value="${last.startsWith("epub") ? "" : esc(last)}">
        <button>開始讀</button>
      </form>
      <label class="add epub">📖 匯入 EPUB<input id="epubIn" type="file" accept=".epub,application/epub+zip" hidden></label>
      <p class="sub" id="epubMsg"></p>`;
    $("epubIn").onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      $("epubMsg").textContent = `處理中…(${(f.size / 1048576).toFixed(1)} MB)`;
      try { load(await importEpub(f)); } catch (err) { $("epubMsg").textContent = err.message || "這不是有效的 EPUB 檔"; }
    };
    $("urlForm").onsubmit = (e) => { e.preventDefault(); load($("urlIn").value); };
    renderShelf();
  }

  // 書封：用書名第一個字 + 依書名算出的顏色
  const COVER_COLORS = ["#b4532a", "#2b62b8", "#2f7a3a", "#7a3fb0", "#c23b72", "#a07a1c", "#1f7a7a", "#5b5b8f"];
  function coverColor(s) { let h = 0; for (const c of s) h = (h * 31 + c.codePointAt(0)) >>> 0; return COVER_COLORS[h % COVER_COLORS.length]; }

  function renderShelf() {
    const books = Object.entries(store.get("shelf", {})).map(([id, b]) => ({ id, ...b })).sort((a, b) => b.at - a.at);
    const ago = (t) => { const d = (Date.now() / 1000 - t) / 86400; return d < 1 ? "今天" : d < 2 ? "昨天" : `${Math.floor(d)} 天前`; };
    if (!books.length) {
      $("text").insertAdjacentHTML("beforeend", `<p class="empty">書架還是空的。貼一個 czbooks 網址，或匯入一本 EPUB 開始吧。</p>`);
      return;
    }
    $("text").insertAdjacentHTML("beforeend", `
      <h2 class="shelf-h">我的書架</h2>
      <div class="shelf">${books.map((b) => {
        const st = bookStats(b.id);
        const name = b.book || "未命名";
        const isEpub = b.url.startsWith("epub");
        const pct = isEpub && b.total ? Math.round((b.idx / b.total) * 100) : null;
        const left = st.words - st.known;
        return `
        <article class="bk" data-open="${esc(b.url)}">
          <div class="cover" style="background:${coverColor(name)}">${esc([...name][0] || "書")}</div>
          <div class="info">
            <div class="name">${esc(name)}</div>
            <div class="where">讀到 ${esc(b.title)}${isEpub && b.total ? `(${b.idx}/${b.total})` : ""} · ${ago(b.at)}</div>
            ${pct !== null ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ""}
            <div class="chips">
              <span class="chip hot">${isEpub ? "全書可學" : "已遇到可學"}單字 ${left.toLocaleString()}</span>
              ${st.known ? `<span class="chip">已熟 ${st.known}</span>` : ""}
              ${!isEpub ? `<span class="chip">讀了 ${st.read} 章</span>` : ""}
            </div>
          </div>
          <button class="more" data-remove="${esc(b.id)}" aria-label="移除">×</button>
        </article>`;
      }).join("")}</div>
      <p class="foot">支援 czbooks.net 和 EPUB(只存在這支手機)。半夏小說擋雲端抓取，請用電腦版。簡體自動轉繁體；單字從多益/托福/雅思字表對照，不用 AI。</p>`);
  }

  function render() {
    if (!chap) return;
    $("bookTitle").textContent = chap.book;
    $("chapTitle").textContent = chap.title;
    const words = activeWords().sort((a, b) => b.zh.length - a.zh.length);
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
      <button data-go="${esc(chap.next || "")}" ${chap.next ? "" : "disabled"}>下一章 ›</button></div>`;
    const src = chap.url.startsWith("epub")
      ? `<div class="src">EPUB · 僅供個人學習</div>`
      : `<div class="src">原文出處:<a href="${esc(chap.url)}" target="_blank" rel="noopener">${esc(chap.url)}</a><br>僅供個人學習</div>`;
    $("text").innerHTML = html + nav + src;
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
      ${others.length ? `<div class="kv"><span>同義</span><span>${others.map((x) =>
        `<span class="col" data-say="${esc(x.en)}">${esc(x.en)}</span> <small>Lv${x.level}</small>`).join("、")}</span></div>` : ""}
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
    serif: ["襯線斜體", 'Georgia, "Times New Roman", serif', "italic"],
    serifUp: ["襯線正體", 'Georgia, "Times New Roman", serif', "normal"],
    sans: ["無襯線", '-apple-system, "Helvetica Neue", Arial, sans-serif', "normal"],
  };
  let wordColor = store.get("wordColor", "theme");
  let bodyFont = store.get("bodyFont", "serif");
  let enFont = store.get("enFont", "serif");
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
      ${seg("theme", t, [["auto", "自動"], ["light", "白"], ["sepia", "米黃"], ["green", "護眼綠"]])}
      ${seg("theme", t, [["dark", "夜間"], ["black", "純黑"]])}
      <p class="sub">英文字顏色</p>
      <div class="seg">${Object.entries(WORD_COLORS).map(([k, [label, light]]) =>
        `<button data-set="wordColor" data-val="${k}" class="${k === wordColor ? "on" : ""}" style="${light ? `color:${light};font-weight:600` : ""}">${label}</button>`).join("")}</div>
      <p class="sub">中文字體</p>
      ${seg("bodyFont", bodyFont, Object.entries(BODY_FONTS).map(([k, [label]]) => [k, label]))}
      <p class="sub">英文字體</p>
      ${seg("enFont", enFont, Object.entries(EN_FONTS).map(([k, [label]]) => [k, label]))}
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
    const ef = EN_FONTS[enFont] || EN_FONTS.serif;
    root.setProperty("--en-font", ef[1]);
    root.setProperty("--en-style", ef[2]);
    if (bodyFont === "kai" && !document.getElementById("kaiFont")) {  // 文楷：用到才從 Google Fonts 載入
      const l = document.createElement("link");
      l.id = "kaiFont"; l.rel = "stylesheet";
      l.href = "https://fonts.googleapis.com/css2?family=LXGW+WenKai+TC&display=swap";
      document.head.appendChild(l);
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#faf7f0";
  }
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyLook);

  // ---------- 事件 ----------
  $("slider").value = level;
  $("slider").addEventListener("input", (e) => { level = +e.target.value; store.set("level", level); render(); });
  $("btnWords").onclick = showWordbook;
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
    const open = e.target.closest("[data-open]");
    if (open) { load(open.dataset.open); return; }
    const go = e.target.closest("[data-go]");
    if (go && go.dataset.go) { load(go.dataset.go); return; }
    const w = e.target.closest(".w");
    if (w) { w.classList.add("on"); showWord(chap.words.find((x) => x.zh === w.dataset.zh), w.dataset.en); }
  });

  $("sheet").addEventListener("click", (e) => {
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
  const startUrl = new URLSearchParams(location.search).get("url") || store.get("lastUrl", "");
  startUrl ? load(startUrl) : showHome();
})();
