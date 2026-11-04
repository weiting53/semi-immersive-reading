"""把多益 / 托福 / 雅思 / GRE 單字表 + 小說精選同義字/片語，整理成「中文詞 → 英文候選」對照表 data/vocab.json。

資料來源(放在 --src 資料夾):
- toeic.json  : LEE-WHITE/toeic-vocab-tw (Hugging Face, CC-BY-4.0),多益字與片語，繁中釋義、星級、例句
- ecdict.csv  : skywind3000/ECDICT (MIT),托福/雅思/GRE 標記、音標、字頻
- cmudict.dict : cmusphinx/cmudict (BSD),美式發音 → 轉 KK 音標
- data/*_extra.json(專案內):小說常見詞的進階同義字與片語，人工整理
- data/colloc/*.json(專案內):常用搭配詞 {英文: [[搭配, 中文], ...]},人工整理

一個中文詞可以有多個英文候選(由簡單到難),閱讀器會依密度等級挑、每次出現輪流換。
用法: python tools/build_vocab.py --src <下載資料夾>
"""
import argparse
import csv
import json
import re
from pathlib import Path

from opencc import OpenCC

from kk import load_cmu, phrase_kk

ROOT = Path(__file__).resolve().parent.parent
s2t = OpenCC("s2twp").convert
CJK = re.compile(r"^[一-鿿]{2,5}$")
NUM = re.compile(r"[一二三四五六七八九十百千萬兩幾]")  # 數字詞(五十、四個)不換
EASY_FRQ = 1000  # 字頻前 1000 的字(time、speak)太簡單，不換
RARE_FRQ = 25000  # 字頻 2.5 萬名後或不明的字多半是冷僻字/字表雜訊，不收
COMMON_FRQ = 8000  # 不在考試字表、但字頻前 8000 的字當「基礎字」,擋掉同義的怪字
BAN = {"bob", "hue", "celestial", "advent", "chic", "stature", "upstage", "geddit", "tim",
       "vestment", "anterior", "opine", "plenary", "necessity", "certainty", "notwithstanding", "whilst"}
GRE_FRQ = 12000  # 只在 GRE 的字更容易偏掉，字頻要更常見才收
MAX_CANDS = 5
STOP = set("""
一個 一些 一種 這個 那個 什麼 怎麼 沒有 可以 不是 就是 因為 所以 但是 如果 已經 還是 這樣 那樣 自己 我們 他們 你們
東西 事情 時候 地方 今天 明天 昨天 現在 以後 以前 一起 一下 一定 非常 很多 一點 有點 然後 其他 可能 應該
人們 男人 女人 先生 小姐 方面 部分 問題 情況 方法 進行 出來 起來 下來 上來 過來 知道 覺得 認為 看到 聽到
""".split())
WORD = re.compile(r"[a-z][a-z\-]+")
PHRASE = re.compile(r"[a-z][a-z\-']*(?: [a-z][a-z\-']*){1,4}")


def split_terms(defn: str) -> list[str]:
    """'n. 預約；保留(座位)' → ['預約', '保留']。保持原順序(第一個 = 主要意思)。"""
    out = []
    for line in defn.replace("\\n", "\n").splitlines():
        line = line.strip()
        if not line or line.startswith("["):  # [網路]、[醫] 等專業/網路釋義不要
            continue
        line = re.sub(r"^(?:[a-z]+\.\s*)+", "", line)  # 詞性
        line = re.sub(r"[（(][^）)]*[）)]", "", line)  # 括號說明
        line = re.sub(r"<[^>]*>", "", line)
        for t in re.split(r"[；;，,、/：:\s]+", line):
            t = t.strip("…．.。")
            # 「回答的」這類形容詞/副詞釋義不拿掉「的」,免得把名詞/動詞的中文換成形容詞
            if CJK.match(t) and len(t) <= 4 and t not in STOP and t not in out and not NUM.search(t):
                out.append(t)
    return out


def base_terms(terms: list[str]) -> list[str]:
    """基礎字拿來擋人：「漂亮的」也要擋「漂亮」,所以補上去掉「的/地」的版本。"""
    out = []
    for t in terms:
        for x in (t, t.rstrip("的地")):
            if CJK.match(x) and x not in out:
                out.append(x)
    return out


def main(src: Path) -> None:
    words: dict[str, dict] = {}

    # 1. 多益(單字 + 片語)
    toeic = json.loads((src / "toeic.json").read_text(encoding="utf-8"))
    for group in toeic["vocabulary_by_importance"].values():
        for w in group:
            en = re.sub(r"\s*\(.*?\)", "", w["english_word"]).strip()
            is_phrase = " " in en
            if not (PHRASE if is_phrase else WORD).fullmatch(en):
                continue
            star = int(w.get("star_rating") or 1)
            ex = (w.get("examples") or [{}])[0].get("english", "")
            words[en] = {
                "en": en, "gloss": w["chinese_definition"], "terms": split_terms(w["chinese_definition"]),
                "exams": ["TOEIC"], "star": star, "example": ex, "ipa": "",
                "frq": 5000 if is_phrase else 999999,  # 片語沒有字頻，當作中等常用
            }

    # 2. ECDICT:音標/字頻/托福雅思 GRE 標記；基礎字當擋人用
    basic: dict[str, dict] = {}
    inflected: set[str] = set()
    with open(src / "ecdict.csv", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            en = r["word"].strip()
            if not WORD.fullmatch(en):
                continue
            ex_map = dict(p.split(":", 1) for p in r["exchange"].split("/") if ":" in p)
            if "0:" in r["exchange"] and ("i" not in ex_map.get("1", "") or "s" not in ex_map):
                inflected.add(en)  # liked、likes 這類變化形只留原形;meeting 這種有複數的 -ing 名詞保留
                continue
            tags = r["tag"].split()
            frq = int(r["frq"] or 0) or 999999
            exam_tags = [n for t, n in (("toefl", "TOEFL"), ("ielts", "IELTS"), ("gre", "GRE")) if t in tags]
            w = words.get(en)
            if w is None and not exam_tags:
                if "zk" in tags or "gk" in tags or frq <= COMMON_FRQ:
                    basic[en] = {"en": en, "terms": base_terms(split_terms(s2t(r["translation"]))), "frq": frq}
                continue
            if w is None:
                zh = s2t(r["translation"])
                first = [l for l in zh.replace("\\n", "\n").splitlines() if l and not l.startswith("[")]
                w = words[en] = {"en": en, "terms": split_terms(zh), "exams": [], "star": 0, "example": "",
                                 "ipa": "", "gloss": re.sub(r"^(?:[a-z]+\.\s*)+", "", first[0]) if first else ""}
            w["ipa"] = w["ipa"] or r["phonetic"]
            w["frq"] = frq
            for n in exam_tags:
                if n not in w["exams"]:
                    w["exams"].append(n)

    for en in inflected | BAN:
        words.pop(en, None)
    for en in [en for en, w in words.items() if " " not in en and w["frq"] < EASY_FRQ]:
        w = words.pop(en)  # 太簡單：不換，改當基礎字擋人
        basic[en] = {"en": en, "terms": base_terms(w["terms"]), "frq": w["frq"]}
    for en in [en for en, w in words.items() if w["frq"] > RARE_FRQ]:
        words.pop(en)
    for en in [en for en, w in words.items() if w["exams"] == ["GRE"] and w["frq"] > GRE_FRQ]:
        words.pop(en)

    # 等級:1-3 = 多益 5/4/3 星;4 = 多益 1-2 星、托福、雅思;5 = 只有 GRE 才有的進階字
    for w in words.values():
        if w["star"]:
            w["level"] = {5: 1, 4: 2, 3: 3}.get(w["star"], 4)
        else:
            w["level"] = 4 if ("TOEFL" in w["exams"] or "IELTS" in w["exams"]) else 5

    # 3. 中文詞 → 英文候選
    blocked = {t for w in basic.values() for t in w["terms"][:4]}
    cands: dict[str, dict[str, tuple]] = {}
    for w in words.values():
        is_toeic = "TOEIC" in w["exams"]
        for rank, t in enumerate(w["terms"][:2 if is_toeic else 1]):
            # 多益字表是人工整理的繁中釋義，前兩個意思都收；ECDICT 只收第一個意思。
            # 若基礎字也有這個意思(身體 → body)且不是該字的第一個意思，就不收，避免換成 bodily 這種怪字。
            if t in blocked and rank > 0:
                continue
            cands.setdefault(t, {})[w["en"]] = (rank, w["level"], w["frq"])

    # 4. 人工精選(小說常見詞、商業/科學/電腦)：直接採用，不受擋人規則限制，排在字典候選前面
    curated: dict[str, list[str]] = {}
    for path in sorted((ROOT / "data").glob("*_extra.json")):
        for t, items in json.loads(path.read_text(encoding="utf-8")).items():
            if t.startswith("_") or not CJK.match(t):  # 單字中文(稅、氫)太容易誤換，不收
                continue
            for en, level, gloss in items:
                w = words.get(en)
                if w is None:
                    w = words[en] = {"en": en, "gloss": gloss, "exams": [], "example": "", "level": level,
                                     "ipa": "", "frq": 5000, "terms": [t]}
                if "精選" not in w["exams"]:
                    w["exams"].append("精選")
                lst = curated.setdefault(t, [])
                if en not in lst:
                    lst.append(en)
                cands.setdefault(t, {})[en] = (0, level, 0)

    # 補音標(精選字可能在 ECDICT 但不在考試字表)
    need = {en for en, w in words.items() if not w["ipa"] and " " not in en}
    if need:
        with open(src / "ecdict.csv", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                if r["word"] in need:
                    words[r["word"]]["ipa"] = r["phonetic"]

    exclude = set(json.loads((ROOT / "data" / "exclude_terms.json").read_text(encoding="utf-8"))["terms"])
    index = {}
    for t, c in cands.items():
        if t in exclude and t not in curated:  # 使用者回報換錯的詞
            continue
        first = sorted(curated.get(t, []), key=lambda en: c[en][1])  # 精選在前(由簡單到難)
        # 有精選的詞只用精選(字典候選常有詞性/意思偏掉，如 放棄 → waiver)
        rest = [] if first else sorted(c, key=lambda en: (c[en][1], c[en][0], c[en][2]))
        index[t] = (first + rest)[:MAX_CANDS]
    used = {en for v in index.values() for en in v}
    mnem = {}
    for path in sorted((ROOT / "data").glob("mnemonic_*.json")):  # 諧音記憶(人工整理)
        mnem.update(json.loads(path.read_text(encoding="utf-8")))
    colloc = {}
    for path in sorted((ROOT / "data" / "colloc").glob("*.json")):  # 常用搭配詞(人工整理)
        colloc.update(json.loads(path.read_text(encoding="utf-8")))
    cmu = load_cmu(src / "cmudict.dict")
    for en in used:
        words[en]["kk"] = phrase_kk(en, cmu) or ""
        words[en]["mnem"] = mnem.get(en, "")
    vocab = {
        "source": "TOEIC: LEE-WHITE/toeic-vocab-tw (CC-BY-4.0); TOEFL/IELTS/GRE + IPA: skywind3000/ECDICT (MIT); "
                  "novel_extra.json: 人工整理",
        "index": index,
        "words": {en: {**{k: words[en][k] for k in ("gloss", "ipa", "kk", "mnem", "exams", "level")},
                       **({"co": colloc[en]} if colloc.get(en) else {})} for en in used},
    }
    dest = ROOT / "public" / "data" / "vocab.json"
    dest.write_text(json.dumps(vocab, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    multi = sum(1 for v in index.values() if len(v) > 1)
    phrases = sum(1 for en in used if " " in en)
    print(f"words={len(used)} phrases={phrases} terms={len(index)} multi={multi} -> {dest}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", type=Path, required=True)
    main(ap.parse_args().src)
