"""CMU Pronouncing Dictionary (ARPAbet, 美式) → KK 音標。"""
import re

VOWEL = {"AA": "ɑ", "AE": "æ", "AO": "ɔ", "AW": "aʊ", "AY": "aɪ", "EH": "ɛ", "EY": "e", "IH": "ɪ",
         "IY": "i", "OW": "o", "OY": "ɔɪ", "UH": "ʊ", "UW": "u"}
CONS = {"B": "b", "CH": "tʃ", "D": "d", "DH": "ð", "F": "f", "G": "g", "HH": "h", "JH": "dʒ", "K": "k",
        "L": "l", "M": "m", "N": "n", "NG": "ŋ", "P": "p", "R": "r", "S": "s", "SH": "ʃ", "T": "t",
        "TH": "θ", "V": "v", "W": "w", "Y": "j", "Z": "z", "ZH": "ʒ"}
# 兩個子音能當音節開頭的組合(pl、tr、kw…);其他情況重音符號只往前帶一個子音
ONSET2 = {a + b for a in ("p", "b", "t", "d", "k", "g", "f", "θ", "ʃ") for b in ("l", "r", "w", "j")} | {
    "sm", "sn", "sl", "sw", "mj", "nj", "hj", "vj"}


def vowel(ph: str, stress: str) -> str:
    if ph == "AH":
        return "ʌ" if stress in "12" else "ə"
    if ph == "ER":
        return "ɝ" if stress in "12" else "ɚ"
    return VOWEL[ph]


def to_kk(arpabet: str) -> str:
    segs = []  # (符號, 是否母音, 重音)
    for tok in arpabet.split():
        m = re.fullmatch(r"([A-Z]+)([012]?)", tok)
        ph, st = m.group(1), m.group(2)
        if st:
            segs.append([vowel(ph, st), True, st])
        else:
            segs.append([CONS[ph], False, ""])
    nvow = sum(1 for s in segs if s[1])
    out = [s[0] for s in segs]
    if nvow > 1:  # 單音節字不標重音
        for i, (sym, is_v, st) in enumerate(segs):
            if not is_v or st not in ("1", "2"):
                continue
            mark = "ˋ" if st == "1" else "ˏ"
            j = i
            if j > 0 and not segs[j - 1][1]:
                j -= 1
                if j > 0 and not segs[j - 1][1] and segs[j - 1][0] + segs[j][0] in ONSET2:
                    j -= 1
            out[j] = mark + out[j]
    return "".join(out)


def load_cmu(path) -> dict:
    d = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.split("#")[0].strip()
            if not line:
                continue
            w, pron = line.split(" ", 1)
            if "(" in w:  # 只取第一種唸法
                continue
            d[w] = pron
    return d


def phrase_kk(text: str, cmu: dict):
    """片語、連字號字逐字轉換；有任何一個字查不到就回傳 None(改顯示字典音標)。"""
    out = []
    for part in re.split(r"([ \-])", text.lower()):
        if part in (" ", "-", ""):
            out.append(part)
            continue
        p = cmu.get(part)
        if p is None:
            return None
        out.append(to_kk(p))
    return "".join(out)
