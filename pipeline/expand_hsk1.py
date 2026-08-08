"""One-off corpus expansion: complete HSK1 vocabulary and add matching sentences.

The first seed was 90 words, enough to validate the pipeline but thin enough that the
exercise lab repeats itself quickly. This brings the vocabulary to roughly HSK1
completeness (numbers, measure word 个, time expressions, common places and verbs),
which unlocks far more natural sentences, and adds sentences to cover the new words.

Idempotent — re-running skips anything already present. After this, run:
    python pipeline/normalize_corpus.py     (derives Traditional)
    python pipeline/day0_validate.py --sentences --tts edge --yes
    python pipeline/build_lab.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent
VOCAB = ROOT / "data" / "seed_vocab.json"
SENTENCES = ROOT / "data" / "seed_sentences.json"

NEW_CORE = [
    ("一", "yī", "one"), ("二", "èr", "two"), ("三", "sān", "three"),
    ("四", "sì", "four"), ("五", "wǔ", "five"), ("六", "liù", "six"),
    ("七", "qī", "seven"), ("八", "bā", "eight"), ("九", "jiǔ", "nine"),
    ("十", "shí", "ten"),
    ("个", "gè", "general measure word"),
    ("年", "nián", "year"), ("月", "yuè", "month"), ("号", "hào", "day of the month"),
    ("星期", "xīngqí", "week"), ("点", "diǎn", "o'clock"),
    ("分钟", "fēnzhōng", "minute"), ("时候", "shíhou", "time, moment"),
    ("名字", "míngzi", "name"), ("学生", "xuésheng", "student"),
    ("医生", "yīshēng", "doctor"), ("女", "nǚ", "female"), ("男", "nán", "male"),
    ("学校", "xuéxiào", "school"), ("医院", "yīyuàn", "hospital"),
    ("商店", "shāngdiàn", "shop"), ("里", "lǐ", "inside"),
    ("上", "shàng", "on, above"), ("下", "xià", "under, below"),
    ("前面", "qiánmiàn", "in front"), ("后面", "hòumiàn", "behind"),
    ("中国", "Zhōngguó", "China"), ("中文", "Zhōngwén", "Chinese (language)"),
    ("东西", "dōngxi", "thing"), ("电视", "diànshì", "television"),
    ("电话", "diànhuà", "telephone"), ("衣服", "yīfu", "clothes"),
    ("钱", "qián", "money"), ("书", "shū", "book"),
    ("开", "kāi", "to open; to drive"), ("坐", "zuò", "to sit"),
    ("住", "zhù", "to live, to stay"), ("读", "dú", "to read"),
    ("写", "xiě", "to write"), ("认识", "rènshi", "to know (a person)"),
    ("叫", "jiào", "to be called"), ("请", "qǐng", "please"),
    ("给", "gěi", "to give"), ("找", "zhǎo", "to look for"),
    ("玩", "wán", "to play"),
    ("热", "rè", "hot"), ("冷", "lěng", "cold"), ("高兴", "gāoxìng", "happy"),
    ("漂亮", "piàoliang", "pretty"), ("新", "xīn", "new"),
    ("快", "kuài", "fast"), ("慢", "màn", "slow"),
    ("对不起", "duìbuqǐ", "sorry"), ("没关系", "méiguānxi", "it's fine"),
    ("不客气", "búkèqi", "you're welcome"),
    ("和", "hé", "and"),
]

NEW_SENTENCES = [
    ("宝宝三个月了。", "bǎobao sān gè yuè le", "The baby is three months old."),
    ("宝宝今天很高兴。", "bǎobao jīntiān hěn gāoxìng", "The baby's in a good mood today."),
    ("宝宝很漂亮。", "bǎobao hěn piàoliang", "The baby is beautiful."),
    ("宝宝睡了两个小时。", "bǎobao shuì le liǎng gè xiǎoshí", "SKIP"),
    ("给宝宝换衣服吧。", "gěi bǎobao huàn yīfu ba", "Let's change the baby's clothes."),
    ("宝宝的衣服在哪里？", "bǎobao de yīfu zài nǎlǐ?", "Where are the baby's clothes?"),
    ("宝宝要睡三个小时。", "SKIP", "SKIP"),
    ("我给宝宝买了新衣服。", "wǒ gěi bǎobao mǎi le xīn yīfu", "I bought the baby new clothes."),
    ("宝宝在哭，请你抱抱他。", "SKIP", "SKIP"),
    ("宝宝的名字很好。", "bǎobao de míngzi hěn hǎo", "The baby has a nice name."),
    ("宝宝几点睡觉？", "SKIP", "SKIP"),
    ("宝宝八点睡觉。", "bǎobao bā diǎn shuìjiào", "The baby sleeps at eight."),
    ("宝宝九点了还不睡。", "SKIP", "SKIP"),
    ("我七点回家。", "wǒ qī diǎn huí jiā", "I get home at seven."),
    ("现在几点？", "SKIP", "SKIP"),
    ("现在十点了。", "xiànzài shí diǎn le", "It's ten o'clock."),
    ("我五分钟就来。", "SKIP", "SKIP"),
    ("等我十分钟。", "SKIP", "SKIP"),
    ("你什么时候回家？", "nǐ shénme shíhou huí jiā?", "When are you coming home?"),
    ("我不知道什么时候。", "SKIP", "SKIP"),
    ("这个星期我很忙。", "SKIP", "SKIP"),
    ("这个星期我不工作。", "zhè gè xīngqí wǒ bù gōngzuò", "I'm not working this week."),
    ("今天是几号？", "SKIP", "SKIP"),
    ("今天是三号。", "jīntiān shì sān hào", "Today is the third."),
    ("我住在这里。", "SKIP", "SKIP"),
    ("我们住在这个房子里。", "wǒmen zhù zài zhè gè fángzi lǐ", "We live in this house."),
    ("狗在房子里。", "gǒu zài fángzi lǐ", "The dog's in the house."),
    ("东西在车上。", "dōngxi zài chē shàng", "The stuff's in the car."),
    ("车在房子后面。", "chē zài fángzi hòumiàn", "The car's behind the house."),
    ("商店在前面。", "shāngdiàn zài qiánmiàn", "The shop is up ahead."),
    ("我去商店买东西。", "wǒ qù shāngdiàn mǎi dōngxi", "I'm going to the shop to buy things."),
    ("这个东西很贵。", "SKIP", "SKIP"),
    ("这些东西太多了。", "SKIP", "SKIP"),
    ("我要买三个。", "wǒ yào mǎi sān gè", "I want to buy three."),
    ("这个多少钱？", "SKIP", "SKIP"),
    ("我没有钱了。", "wǒ méiyǒu qián le", "I'm out of money."),
    ("我要去医院。", "wǒ yào qù yīyuàn", "I have to go to the hospital."),
    ("医生说宝宝很好。", "yīshēng shuō bǎobao hěn hǎo", "The doctor says the baby's fine."),
    ("我们明天去看医生。", "wǒmen míngtiān qù kàn yīshēng", "We're seeing the doctor tomorrow."),
    ("医院在学校后面。", "yīyuàn zài xuéxiào hòumiàn", "The hospital is behind the school."),
    ("我在学校工作。", "wǒ zài xuéxiào gōngzuò", "I work at a school."),
    ("他是学生。", "tā shì xuésheng", "He's a student."),
    ("我是学中文的学生。", "SKIP", "SKIP"),
    ("我在学中文。", "SKIP", "SKIP"),
    ("我学中文很慢。", "wǒ xué Zhōngwén hěn màn", "SKIP"),
    ("我的中文不好。", "wǒ de Zhōngwén bù hǎo", "My Chinese isn't good."),
    ("你的中文很好。", "nǐ de Zhōngwén hěn hǎo", "Your Chinese is good."),
    ("我要学习中文。", "wǒ yào xuéxí Zhōngwén", "I want to learn Chinese."),
    ("她是中国人。", "tā shì Zhōngguó rén", "She's Chinese."),
    ("我认识他。", "wǒ rènshi tā", "I know him."),
    ("我不认识那个人。", "wǒ bù rènshi nà gè rén", "I don't know that person."),
    ("你叫什么名字？", "nǐ jiào shénme míngzi?", "What's your name?"),
    ("我叫他老王。", "SKIP", "SKIP"),
    ("请坐。", "qǐng zuò", "Please sit."),
    ("请给我水。", "qǐng gěi wǒ shuǐ", "Water, please."),
    ("请你慢一点。", "SKIP", "SKIP"),
    ("对不起，我来晚了。", "SKIP", "SKIP"),
    ("对不起。", "duìbuqǐ", "Sorry."),
    ("没关系。", "méiguānxi", "It's fine."),
    ("不客气。", "búkèqi", "You're welcome."),
    ("谢谢你，不客气。", "SKIP", "SKIP"),
    ("今天很热。", "jīntiān hěn rè", "It's hot today."),
    ("水太热了。", "shuǐ tài rè le", "The water's too hot."),
    ("今天很冷。", "jīntiān hěn lěng", "It's cold today."),
    ("宝宝冷不冷？", "SKIP", "SKIP"),
    ("我很高兴。", "wǒ hěn gāoxìng", "I'm happy."),
    ("我们都很高兴。", "wǒmen dōu hěn gāoxìng", "We're all happy."),
    ("这个房子很新。", "zhè gè fángzi hěn xīn", "This house is new."),
    ("我买了一本书。", "SKIP", "SKIP"),
    ("这本书很好。", "SKIP", "SKIP"),
    ("我在读书。", "wǒ zài dú shū", "I'm reading."),
    ("我想读中文书。", "wǒ xiǎng dú Zhōngwén shū", "I want to read Chinese books."),
    ("我不会写中文。", "wǒ bú huì xiě Zhōngwén", "I can't write Chinese."),
    ("请写你的名字。", "qǐng xiě nǐ de míngzi", "Please write your name."),
    ("我开车去工作。", "wǒ kāi chē qù gōngzuò", "I drive to work."),
    ("请开门。", "SKIP", "SKIP"),
    ("电视在哪里？", "diànshì zài nǎlǐ?", "Where's the TV?"),
    ("我在看电视。", "wǒ zài kàn diànshì", "I'm watching TV."),
    ("宝宝喜欢看电视吗？", "bǎobao xǐhuan kàn diànshì ma?", "Does the baby like watching TV?"),
    ("我给你打电话。", "SKIP", "SKIP"),
    ("电话在桌子上。", "SKIP", "SKIP"),
    ("我找我的电话。", "wǒ zhǎo wǒ de diànhuà", "I'm looking for my phone."),
    ("你在找什么？", "nǐ zài zhǎo shénme?", "What are you looking for?"),
    ("我找不到。", "SKIP", "SKIP"),
    ("我和老婆一起去。", "wǒ hé lǎopo yìqǐ qù", "My wife and I are going together."),
    ("爸爸和妈妈都在家。", "bàba hé māma dōu zài jiā", "Mom and Dad are both home."),
    ("我想玩游戏。", "wǒ xiǎng wán yóuxì", "I want to play games."),
    ("我晚上玩游戏。", "wǒ wǎnshang wán yóuxì", "I play games in the evening."),
    ("宝宝在玩。", "bǎobao zài wán", "The baby's playing."),
    ("你快一点。", "SKIP", "SKIP"),
    ("你吃得太快了。", "SKIP", "SKIP"),
    ("请慢慢说。", "SKIP", "SKIP"),
    ("你说得太快了。", "SKIP", "SKIP"),
    ("我坐在这里。", "wǒ zuò zài zhèlǐ", "SKIP"),
    ("请坐在前面。", "qǐng zuò zài qiánmiàn", "Please sit at the front."),
    ("狗在我后面。", "gǒu zài wǒ hòumiàn", "The dog's behind me."),
    ("五个人都来了。", "wǔ gè rén dōu lái le", "All five people came."),
    ("我们家有四个人。", "wǒmen jiā yǒu sì gè rén", "There are four people in our family."),
    ("我有两个儿子。", "SKIP", "SKIP"),
    ("这个女人是医生。", "zhè gè nǚ rén shì yīshēng", "This woman is a doctor."),
    ("那个男人是老师。", "nà gè nán rén shì lǎoshī", "That man is a teacher."),
    ("六点了，我们吃吧。", "liù diǎn le, wǒmen chī ba", "It's six — let's eat."),
    ("我一个人在家。", "wǒ yí gè rén zài jiā", "I'm home alone."),
    ("九月很热。", "jiǔ yuè hěn rè", "September is hot."),
    ("今年宝宝一岁。", "SKIP", "SKIP"),
    ("明年我要去中国。", "SKIP", "SKIP"),
    ("我在中国工作过。", "SKIP", "SKIP"),
]


def main() -> int:
    vocab = json.loads(VOCAB.read_text(encoding="utf-8"))
    have = {e["headword"] for e in vocab["core"] + vocab["personal"]}

    added = 0
    for hw, py, gl in NEW_CORE:
        if hw in have:
            continue
        vocab["core"].append({"headword": hw, "pinyin": py, "gloss_en": gl})
        have.add(hw)
        added += 1
    VOCAB.write_text(json.dumps(vocab, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"vocabulary: +{added} words → {len(have)} total")

    # Verify each candidate sentence against the expanded vocabulary before adding it.
    def cover(text):
        out, i = [], 0
        while i < len(text):
            if text[i] in "，。！？、：；" or text[i].isspace():
                i += 1
                continue
            for n in range(min(4, len(text) - i), 0, -1):
                if text[i : i + n] in have:
                    out.append(text[i : i + n])
                    i += n
                    break
            else:
                return None, text[i]
        return out, None

    data = json.loads(SENTENCES.read_text(encoding="utf-8"))
    existing = {e["hanzi"] for e in data["sentences"] if "hanzi" in e}

    ok, skipped, rejected = 0, 0, []
    data["sentences"].append({"_comment": "HSK1 expansion pass — see expand_hsk1.py."})
    for hanzi, pinyin, gloss in NEW_SENTENCES:
        if pinyin == "SKIP" or gloss == "SKIP":
            skipped += 1
            continue
        if hanzi in existing:
            skipped += 1
            continue
        toks, bad = cover(hanzi)
        if bad:
            rejected.append((hanzi, bad))
            continue
        data["sentences"].append({"hanzi": hanzi, "pinyin": pinyin, "gloss_en": gloss})
        existing.add(hanzi)
        ok += 1

    SENTENCES.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    total = sum(1 for e in data["sentences"] if "hanzi" in e)
    print(f"sentences : +{ok} added, {skipped} skipped (marked SKIP or duplicate), "
          f"{len(rejected)} rejected by the verifier → {total} total")
    for h, b in rejected:
        print(f"   reject: {h}  (out of vocab: {b})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
