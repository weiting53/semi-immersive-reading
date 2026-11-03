# 半沉浸式英語閱讀

讀中文小說，把部分詞換成多益/托福/雅思英文單字的手機閱讀器(PWA)。

- 單字對照、EPUB 匯入、簡轉繁、書架、生字本：全部在手機瀏覽器裡跑，資料存在手機(localStorage / IndexedDB)。
- 網路小說(czbooks.net、半夏小說 xbanxia.cc):經過 Cloudflare Worker 的 `/api/fetch` 代抓，只准抓這兩個網站。
- 本 repo 不含任何小說內容；讀到的章節只快取在自己的手機上。僅供個人學習。

## 結構

```
public/          PWA 靜態檔(index.html、app.js、sw.js、manifest、data/vocab.json、vendor/)
src/worker.js    Cloudflare Worker:靜態檔 + /api/fetch
wrangler.jsonc   Worker 設定
data/            人工整理的詞表(*_extra.json)、諧音(mnemonic_*.json)、排除詞(exclude_terms.json)
tools/           build_vocab.py(產生 public/data/vocab.json)、kk.py(CMUdict → KK 音標)
```

## 部署

```
npx wrangler login     # 第一次，瀏覽器登入 Cloudflare
npx wrangler deploy    # 之後每次更新
```

## 更新單字表

1. 改 `data/novel_extra.json`(或其他 `*_extra.json`、`mnemonic_*.json`、`exclude_terms.json`)。
2. 下載原始資料到同一個資料夾(不放進 repo):
   - `toeic.json`:LEE-WHITE/toeic-vocab-tw 的 `data/toeic_vocabulary.json`
   - `ecdict.csv`:skywind3000/ECDICT 的 `ecdict.csv`
   - `cmudict.dict`:cmusphinx/cmudict 的 `cmudict.dict`
3. `pip install opencc-python-reimplemented`,然後 `python tools/build_vocab.py --src <資料夾>`
4. `public/sw.js` 的 `VERSION` 加一號，`npx wrangler deploy`。

## 資料來源與授權

- 多益字表:[LEE-WHITE/toeic-vocab-tw](https://huggingface.co/datasets/LEE-WHITE/toeic-vocab-tw)(CC BY 4.0)
- 托福/雅思/GRE 標記、音標、字頻:[skywind3000/ECDICT](https://github.com/skywind3000/ECDICT)(MIT)
- 美式發音:[cmusphinx/cmudict](https://github.com/cmusphinx/cmudict)(BSD-2-Clause),轉成 KK 音標
- [JSZip](https://stuk.github.io/jszip/)(MIT)、[opencc-js](https://github.com/nk2028/opencc-js)(MIT)
- `data/*_extra.json`、`data/mnemonic_*.json`:本專案人工整理
