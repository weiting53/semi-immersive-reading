# 半沉浸式英語閱讀

讀中文小說的時候，把一部分詞換成英文。劇情照樣看得懂，英文單字在上下文裡一次次出現，不知不覺就記住了。

> 一句話：用你本來就想看的小說，練多益 / 托福 / 雅思單字。

網址:<https://semi-immersive-reading.english-reader.workers.dev>(iPhone 用 Safari 打開 → 分享 → 加入主畫面)

---

## 看起來像這樣

> 她**suddenly** **turn around**,臉上帶著一抹 **smirk**。
> 「你在 **kid** 我嗎？」他 **frown**,語氣裡滿是 **sarcasm**。

點任何一個英文字，會跳出單字卡:

```
smirk
KK [smɝk]
諧音  斯莫克 → 斯莫克得意假笑
中文  得意的笑、假笑
原文  笑容
等級  Lv5 · 進階
同義  grin Lv4、beam Lv5
[🔊 再聽一次]  [✓ 已熟，不再換]
```

## 功能

| 功能 | 說明 |
|---|---|
| 英文密度 0–5 | 底部滑桿。0 = 原文；1–3 = 多益 5★/4★/3★;4 = 加托福雅思；5 = 進階同義字與片語 |
| 同義字輪替 | 同一個中文詞每次出現換一個英文，例如「笑容」→ smirk / beam / grin,難的先出現 |
| 片語 | give up、out of the blue、roll one's eyes、take a deep breath… |
| 單字卡 | KK 音標、諧音記憶、中文、等級、同義字，點了會唸出來 |
| 已熟 | 標「已熟」的字改回中文，不再換 |
| 生字本 | 本章換了哪些字，一次看完 |
| 書架 | 自動記住每本書讀到哪一章 |
| 來源 | czbooks.net 網址(章節或書本首頁)、本機 EPUB |
| 簡轉繁 | 簡體 / 簡繁混用自動轉台灣繁體 |
| 離線 | 讀過的章節和整個 App 都快取在手機，沒網路也能看 |
| 外觀 | 字級 4 段、背景 白 / 米黃 / 夜間 / 跟系統 |

全部在手機上跑：不用 AI、不用帳號、不花錢。閱讀紀錄只存在自己的手機。

## 單字從哪裡來

約 1 萬個單字、1,400 個片語、1 萬多個中文詞的對照：

- **多益**:9,537 字的多益字表(繁中釋義、星級)
- **托福 / 雅思 / GRE**:ECDICT 英漢字典的考試標記，只收「中文是它的主要意思」的配對，避免換錯
- **小說常用詞**(人工整理，約 600 個):情緒、動作、身體、古言(侍衛、太子、嫁妝、聖旨…)
- **商業 / 自然科學 / 電腦**(人工整理，約 300 個)
- **KK 音標**:由 CMU 美式發音字典轉換
- **諧音記憶**(人工整理，約 700 個)

會刻意跳過：太簡單的字(time、speak)、數字、冷僻字，以及「有更自然簡單說法」的詞(身體 → body,不會換成 bodily)。

## 已知限制

- **半夏小說手機版讀不到**:半夏擋掉雲端伺服器的抓取。要讀半夏，可以用電腦版(見下方)或轉成 EPUB 匯入。
- **詞性不一定對**:對照表不知道句子文法，偶爾會出現「他 discovery 了」。看到換錯的就加進 `data/exclude_terms.json`。
- **動詞不變化時態**:「點了根菸」會顯示 lit a cigarette,但大部分動詞以原形出現。
- **資料不跨裝置同步**:書架、已熟、EPUB 都存在各自的手機瀏覽器裡。

---

## 開發

### 架構

```
手機瀏覽器(PWA)                         Cloudflare Worker
├─ 單字對照(data/vocab.json)            ├─ 提供 public/ 靜態檔
├─ EPUB 解析(JSZip)                    └─ /api/fetch:代抓 czbooks.net 頁面
├─ 簡轉繁(opencc-js)                       (只准 czbooks / 半夏，其他網站一律 403)
├─ 章節快取、EPUB(IndexedDB)
└─ 書架、已熟、設定(localStorage)
```

為什麼需要 Worker:瀏覽器不准網頁直接抓別的網站(CORS),所以抓網路小說要有人代抓。Worker 只轉送頁面，不存任何東西(Cloudflare 會快取 6 小時)。

### 目錄

```
public/            PWA:index.html、app.js、sw.js、manifest、icons/、vendor/、data/vocab.json
src/worker.js      Cloudflare Worker
wrangler.jsonc     Worker 設定
data/              人工整理的資料
  novel_extra.json   小說常用詞(中文 → 英文候選)
  domain_extra.json  商業 / 科學 / 電腦
  mnemonic_*.json    諧音記憶
  exclude_terms.json 不換的中文詞
tools/
  build_vocab.py     產生 public/data/vocab.json
  kk.py              CMUdict → KK 音標
```

### 部署

```bash
npx wrangler login    # 第一次
npx wrangler deploy
```

### 加新詞 / 改對照

1. 改 `data/` 底下的 JSON。格式:`"中文詞": [["英文", 等級, "中文意思"], ...]`,等級 1–5。
2. 把原始資料下載到 repo 外的資料夾(太大，不進 repo):
   - `toeic.json`:[LEE-WHITE/toeic-vocab-tw](https://huggingface.co/datasets/LEE-WHITE/toeic-vocab-tw) 的 `data/toeic_vocabulary.json`
   - `ecdict.csv`:[skywind3000/ECDICT](https://github.com/skywind3000/ECDICT)
   - `cmudict.dict`:[cmusphinx/cmudict](https://github.com/cmusphinx/cmudict)
3. 重建並部署:
   ```bash
   pip install opencc-python-reimplemented
   python tools/build_vocab.py --src <原始資料資料夾>
   # public/sw.js 的 VERSION +1(手機才會更新)
   npx wrangler deploy
   ```

### 電腦版

另有一個 Python 本機版(`server.py`,不在這個 repo),手機跟電腦在同一個 Wi-Fi 時可以用，支援半夏小說。

## 授權與聲明

- 本 repo 不含任何小說內容。讀到的章節只快取在自己的手機上，僅供個人學習，請勿散布。
- 多益字表:LEE-WHITE/toeic-vocab-tw(CC BY 4.0)
- ECDICT(MIT)、CMUdict(BSD-2-Clause)、[JSZip](https://stuk.github.io/jszip/)(MIT)、[opencc-js](https://github.com/nk2028/opencc-js)(MIT)
- `data/` 裡的詞表與諧音為本專案人工整理
