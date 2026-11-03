# Semi-Immersive English Reading (半沉浸式英語閱讀)

**English** | [繁體中文](README.zh-TW.md)

Read Chinese novels with some of the words swapped into English. You can still follow the story, and you see the same English words again and again in context until they stick.

> In one line: practise TOEIC / TOEFL / IELTS vocabulary while reading the novels you already want to read.

<img src="docs/qr.png" width="140" align="right" alt="QR code">

## Install (pick one)

**A. EPUB and pasted text only: 30 seconds, no accounts**

1. Scan the QR code with your phone camera, or open <https://semi-immersive-reading.english-reader.workers.dev>.
2. Add it to your home screen. On iPhone, tap Share → Add to Home Screen in Safari. On Android, tap ⋮ → Add to Home screen in Chrome.
3. Open it from the home screen, then import an EPUB or paste a chapter.

**B. Also open novel URLs directly: about 5 minutes, with free GitHub and Cloudflare accounts**

Web novels are fetched through the cloud, so everyone runs their own free copy and nobody shares a quota.

1. Click this button: [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/weiting53/semi-immersive-reading)
2. Sign in to (or sign up for) Cloudflare, then allow it to connect to GitHub. Sign up for GitHub too if you don't have an account.
3. Click Deploy and wait 1–2 minutes. You'll get a `https://….workers.dev` URL.
4. Open that URL on your phone and add it to your home screen. You can now paste novel URLs.

You can also add an access key so nobody else can fetch novels through your URL. See [Deploy your own copy](#deploy-your-own-copy) below.

---

## What it looks like

> 她**suddenly** **turn around**,臉上帶著一抹 **smirk**。
> 「你在 **kid** 我嗎？」他 **frown**,語氣裡滿是 **sarcasm**。

Tap any English word to open its word card:

```
smirk
KK [smɝk]
諧音  斯莫克 → 斯莫克得意假笑      (Chinese sound-alike mnemonic)
中文  得意的笑、假笑                (meaning)
原文  笑容                          (the original Chinese word)
等級  Lv5 · 進階                    (level)
同義  grin Lv4、beam Lv5            (synonyms)
[🔊 Play again]  [✓ I know this]
```

## Features

| Feature | Details |
|---|---|
| English density 0–5 | Bottom slider. 0 = original text. 1–3 = TOEIC 5★ / 4★ / 3★. 4 = adds TOEFL and IELTS. 5 = advanced synonyms and phrases |
| Rotating synonyms | Each time the same Chinese word appears it uses a different English word, e.g. 笑容 → smirk / beam / grin. Harder words come first |
| Phrases | give up, out of the blue, roll one's eyes, take a deep breath… |
| Word card | KK phonetics, mnemonic, meaning, level and synonyms. The word is read aloud when you tap it |
| Known words | Words marked "I know this" go back to Chinese |
| Word list | Every word swapped in the current chapter |
| Find books in the app | Search czbooks by title or tap a tag (#霸總, #古言…), open a book's page with its blurb, and tap **+ Add to library**. No copying URLs (needs the access key or your own copy) |
| Bookshelf | Home-screen cards show your current chapter, words left to learn, words known, and a progress bar for EPUBs |
| Sources | URLs from sites in `public/sites.json` (czbooks.net out of the box), local EPUB files, or **pasted text** from any app (paid platforms included) |
| Simplified → Traditional | Simplified or mixed text is converted to Taiwan Traditional Chinese automatically |
| Offline | The app and every chapter you've read are cached on the phone |
| Appearance | Font size, line height, six themes (including eye-care green and pure black), English word colour, Chinese font (Ming / Hei / WenKai) and English font |

Everything runs on your phone. There's no AI, no account and no cost, and your reading history never leaves the device.

## Where the words come from

The app maps about 10,000 words, 1,400 phrases and 10,000+ Chinese terms:

- **TOEIC**: a 9,537-word list with Traditional Chinese meanings and star ratings
- **TOEFL / IELTS / GRE**: exam tags from the ECDICT dictionary. A pair is only kept when the Chinese word is the English word's main meaning, so fewer words get swapped wrongly
- **Common novel words** (about 600, hand-curated): emotions, actions, the body, and historical-romance terms such as 侍衛, 太子, 嫁妝, 聖旨
- **Business, natural science and computing** (about 300, hand-curated)
- **KK phonetics**: converted from the CMU American English pronouncing dictionary
- **Sound-alike mnemonics** (about 700, hand-curated)

Some words are skipped on purpose:
- Words that are too easy (time, speak)
- Numbers and rare words
- Chinese words that have a more natural simple English word (身體 stays body and never becomes bodily)

## Known limitations

- **Banxia (半夏小說) doesn't work in the phone app.** The site blocks fetches from cloud servers. Use the desktop version below, or convert the book to EPUB and import it.
- **Part of speech can be wrong.** The mapping doesn't parse grammar, so you'll sometimes see "他 discovery 了". Add words that get swapped wrongly to `data/exclude_terms.json`.
- **Verbs aren't conjugated.** Most verbs appear in their base form.
- **No sync between devices.** The bookshelf, known words and EPUBs are stored in each phone's browser.

---

## Development

### Architecture

```
Phone browser (PWA)                          Cloudflare Worker
├─ word mapping (data/vocab.json)            ├─ serves the static files in public/
├─ EPUB parsing (JSZip)                      └─ /api/fetch: fetches czbooks.net pages for the app
├─ Simplified → Traditional (opencc-js)         (allows only czbooks and Banxia; every other site gets 403)
├─ chapter cache and EPUBs (IndexedDB)
└─ bookshelf, known words, settings (localStorage)
```

The Worker exists because browsers don't let a web page fetch other sites directly (CORS). It only passes pages through and stores nothing itself. Cloudflare caches each page for 6 hours.

### Layout

```
public/            the PWA: index.html, app.js, sw.js, manifest, icons/, vendor/, data/vocab.json
src/worker.js      Cloudflare Worker
wrangler.jsonc     Worker config
data/              hand-curated data
  novel_extra.json   common novel words (Chinese → English candidates)
  domain_extra.json  business / science / computing
  mnemonic_*.json    sound-alike mnemonics
  exclude_terms.json Chinese words never to swap
tools/
  build_vocab.py     builds public/data/vocab.json
  kk.py              CMUdict → KK phonetics
```

### Deploy your own copy

Free on a Cloudflare account. The free plan allows 100,000 chapter fetches a day and never bills you. If the limit is reached, fetching stops until the next day.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/weiting53/semi-immersive-reading)

Or from the command line:

```bash
git clone https://github.com/weiting53/semi-immersive-reading.git
cd semi-immersive-reading
npx wrangler login
npx wrangler deploy
```

Optional: lock web-novel fetching to your own phones.

```bash
npx wrangler secret put ACCESS_KEY      # type any long random string
```

Then open `https://<your-worker>.workers.dev/?key=<that string>` once on each phone. You can also turn that link into a QR code and scan it. The key is saved on the phone. EPUB import and pasted text never need the key.

### Adding a site

Add one line to `public/sites.json`. The Worker uses the same file as its allowlist.

```json
{ "host": "www.example.com", "name": "Example", "parser": "generic" }
```

The `generic` parser finds the largest block of text plus the 上一章 / 下一章 links, and works on most novel sites. Some sites block requests from cloud servers. If so, mark the site `"cloudBlocked": true` and read it with EPUB or pasted text instead.

### Adding words or changing the mapping

1. Edit the JSON files under `data/`. Each entry looks like `"中文詞": [["english", level, "中文意思"], ...]`, with level from 1 to 5.
2. Download the source data into a folder outside the repo. The files are too large to commit.
   - `toeic.json`: `data/toeic_vocabulary.json` from [LEE-WHITE/toeic-vocab-tw](https://huggingface.co/datasets/LEE-WHITE/toeic-vocab-tw)
   - `ecdict.csv`: from [skywind3000/ECDICT](https://github.com/skywind3000/ECDICT)
   - `cmudict.dict`: from [cmusphinx/cmudict](https://github.com/cmusphinx/cmudict)
3. Rebuild and deploy:
   ```bash
   pip install opencc-python-reimplemented
   python tools/build_vocab.py --src <source-data-folder>
   # bump VERSION in public/sw.js so phones pick up the update
   npx wrangler deploy
   ```

### Desktop version

There is also a local Python version (`server.py`, not in this repo). It supports Banxia and works when your phone and computer are on the same Wi-Fi.

## Licences and notice

- This repo contains no novel text. The chapters you read are cached only on your own phone, for personal study. Please don't redistribute them.
- TOEIC word list: LEE-WHITE/toeic-vocab-tw (CC BY 4.0)
- ECDICT (MIT), CMUdict (BSD-2-Clause), [JSZip](https://stuk.github.io/jszip/) (MIT), [opencc-js](https://github.com/nk2028/opencc-js) (MIT)
- The word lists and mnemonics in `data/` were curated by hand for this project.
