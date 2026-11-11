"""Озвучка игры «Художник-склеротик» через Gemini TTS.

Один вызов TTS читает весь раунд (25 номеров + 25 слов), дальше запись режется
по паузам на отдельные клипы, а дорожка раунда собирается с паузами ровно в 1 секунду.

    set GEMINI_API_KEY=...
    python -X utf8 generate_voiceover.py generate --rounds 1-3
    python -X utf8 generate_voiceover.py verify --rounds 1-3

Ответы API кэшируются в .state/raw: повторный запуск не тратит вызовы и деньги.
"""
import argparse
import base64
import difflib
import hashlib
import io
import json
import os
import re
import subprocess
import time
import unicodedata
import urllib.error
import urllib.request
import wave
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

BASE = Path(__file__).resolve().parent
WORDS_FILE = BASE.parent / "game_words_400.json"
ROUNDS_DIR = BASE / "rounds"
RAW_DIR = BASE / ".state" / "raw"
USAGE_LOG = BASE / ".state" / "usage_log.jsonl"
MANIFEST = BASE / "manifest.json"
VERIFICATION = BASE / "verification.json"

API = "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent"
MODELS = ["gemini-3.8-flash-tts", "gemini-3.1-flash-tts-preview", "gemini-3.8-flash-lite-tts"]
VERIFY_MODEL = "gemini-3.8-flash"
DAILY_LIMIT = 100
MAX_BLOCKED = 8  # 3.1-preview часто случайно отвечает finishReason=SAFETY, такой отказ почти бесплатен
MAX_REJECTED = 3  # брак нарезки оплачивается как полноценный дубль

PAUSE_S = 1.0
TARGET_RMS_DB = -20.0
PEAK_LIMIT = 0.89  # -1 dBFS
SILENCE_DB = -40.0
FRAME_S = 0.01
MIN_GAP_S = 0.15
AMBIGUOUS_GAP_RATIO = 0.6

# У каждого раунда свой голос и своя манера: голос, персонаж, сцена, игра.
# Модель назначается по кругу из MODELS. Режиссура намеренно утрированная: с мягкими
# формулировками все модели скатываются в нейтральное чтение списка.
ROUND_PLAN = [
    ("Kore", "Art teacher", "A sunny art class full of small children",
     "Speak warmly and very gently, with a smile, as if every word were a lovely surprise for a child"),
    ("Charon", "Late-night radio host", "A dim radio studio at three in the morning",
     "Speak slowly in a very low, velvety, dreamy voice, lingering on every word"),
    ("Puck", "Sports commentator", "A packed stadium in the last seconds of a cup final",
     "Yell every line at the top of your voice with wild excitement, as if each word were a winning goal"),
    ("Aoede", "Children's party host", "A birthday party with balloons and confetti",
     "Squeal with delight, high-pitched and bubbly, as if every word were the best present ever"),
    ("Algenib", "Old sea captain", "The deck of a ship at anchor in the evening",
     "Growl in a rough, gravelly, salty voice, like a weathered old sailor, and hold a long heavy pause after every line"),
    ("Leda", "Tired station announcer", "A nearly empty train station at the end of a double shift",
     "Drone in a flat, exhausted, utterly bored monotone, sighing and barely caring"),
    ("Orus", "Drill sergeant", "A parade ground at dawn in front of new recruits",
     "Bark every line, loud, harsh and stern, as an order that nobody dares to disobey"),
    ("Achernar", "Keeper of secrets", "A dark library at midnight; nobody must overhear",
     # Настоящий шёпот стирает разницу звонких и глухих: «гость» слышится как «кость».
     "Speak very quietly and secretively in a low, hushed voice, close to the microphone. Do not whisper: keep the voice sounding and every consonant distinct"),
    ("Fenrir", "Scatterbrained old professor", "A cluttered study piled with lost glasses and notes",
     "Speak in a flustered, quavering, elderly voice, hurried and worried, desperately trying not to forget each word"),
    ("Gacrux", "Storytelling grandmother", "A cosy room by the fireplace at bedtime",
     "Speak softly and slowly in a kind old voice, lovingly drawing out every word like a fairy tale"),
    ("Alnilam", "TV news anchor", "A state television studio during an important announcement",
     "Declaim with grave solemnity, formal, stately and resonant, every word of historic importance"),
    ("Zephyr", "Fitness coach", "A gym in the middle of a hard workout",
     "Shout in a punchy, breathless, pumped-up voice, driving the listener on with every line"),
    ("Algieba", "Film noir detective", "A rainy night in a smoky office",
     "Mutter in a low, husky, world-weary voice, slowly and cynically"),
    ("Sulafat", "Museum guide", "The grand hall of a great museum",
     "Speak with refined, awed admiration, breathing out every word as a priceless masterpiece"),
    ("Sadachbia", "Fairground barker", "A noisy fairground",
     "Bellow in a loud, sing-song, teasing voice, rolling out every word like a fabulous prize"),
    ("Iapetus", "Robot", "A factory control room",
     "Speak as a machine: perfectly flat, mechanical and robotic, with no emotion and an exactly equal rhythm"),
]

# На 3.1-preview раунды 2 и 5 почти всегда получали отказ SAFETY.
MODEL_OVERRIDES = {2: MODELS[0], 5: MODELS[0]}


def model_for(round_no):
    return MODEL_OVERRIDES.get(round_no, MODELS[(round_no - 1) % len(MODELS)])


NUMBERS = [
    "Один", "Два", "Три", "Четыре", "Пять", "Шесть", "Семь", "Восемь", "Девять", "Десять",
    "Одиннадцать", "Двенадцать", "Тринадцать", "Четырнадцать", "Пятнадцать", "Шестнадцать",
    "Семнадцать", "Восемнадцать", "Девятнадцать", "Двадцать", "Двадцать один", "Двадцать два",
    "Двадцать три", "Двадцать четыре", "Двадцать пять",
]

# Текст для чтения: возвращает «ё» и снимает омографы. Исходный список не меняется.
SPEECH = {
    "Небоскреб": "Небоскрёб", "Елочная игрушка": "Ёлочная игрушка", "Шепот": "Шёпот",
    "Костер": "Костёр", "Шатер": "Шатёр", "Ковер": "Ковёр", "Матрешка": "Матрёшка",
    "Простыня": "Простыня́", "Черта": "Черта́", "Замок": "Замо́к", "Пила": "Пила́",
    "Стекло": "Стекло́", "Тепло": "Тепло́", "Рога": "Рога́", "Дорога": "Доро́га",
    "Гусеница": "Гу́сеница", "Кузница": "Ку́зница", "Ситечко": "Си́течко", "Компас": "Ко́мпас",
    "Клапан": "Кла́пан", "Спичечный коробок": "Спи́чечный коробо́к", "Заговор": "За́говор",
    "Воронка": "Воро́нка", "Молния": "Мо́лния",
}

LINES = {
    "time_30s": "Список закончился. У вас есть ещё тридцать секунд, чтобы закончить рисунок.",
    "quiz_intro": "Время вышло. Теперь скажите, что было нарисовано в ячейках, которые я назову.",
    # Игрок нажал «Готово», не дожидаясь конца тридцати секунд.
    "quiz_intro_early": "Рисунок готов. Теперь скажите, что было нарисовано в ячейках, которые я назову.",
}

# Реплика, которая звучит вместо другой, выравнивается по её громкости. В общем усилении
# раунда она не участвует, поэтому её добавление не перезаписывает готовые клипы.
SUBSTITUTES = {"quiz_intro_early": "quiz_intro"}

# Слова, которые в общем дубле прозвучали неверно: {раунд: {ячейка: текст}}.
RETAKES = {
    4: {7: "Ле́в.", 13: "По́чка."},
    8: {2: "Гво́здь.", 20: "Ги́ря."},
    10: {16: "Скейт."},
    11: {3: "Луч."},
    13: {1: "Кран.", 14: "Узо́р.", 25: "Су́п."},
    14: {21: "Теле́га.", 22: "Колле́га."},
}


class DailyQuota(Exception):
    pass


class QCError(Exception):
    pass


def calls_today(model):
    # Дневные квоты Gemini сбрасываются в полночь по тихоокеанскому времени.
    today = (datetime.now(timezone.utc) - timedelta(hours=8)).date().isoformat()
    if not USAGE_LOG.exists():
        return 0
    with USAGE_LOG.open(encoding="utf-8") as f:
        return sum(1 for row in map(json.loads, f) if row["model"] == model and row["day"] == today)


def log_usage(model, purpose, usage):
    USAGE_LOG.parent.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    row = {"day": (now - timedelta(hours=8)).date().isoformat(), "time": now.isoformat(timespec="seconds"),
           "model": model, "purpose": purpose, "usage": usage}
    with USAGE_LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def is_daily_quota(error):
    return any("PerDay" in v.get("quotaId", "") for d in error.get("details", []) for v in d.get("violations", []))


def retry_delay(error, default):
    for d in error.get("details", []):
        m = re.fullmatch(r"(\d+)(?:\.\d+)?s", d.get("retryDelay", ""))
        if m:
            return int(m.group(1)) + 2
    return default


def post(model, body):
    req = urllib.request.Request(API.format(model), data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "x-goog-api-key": os.environ["GEMINI_API_KEY"]})
    for attempt in range(1, 7):
        try:
            with urllib.request.urlopen(req, timeout=290) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            raw = e.read().decode(errors="replace")
            error = json.loads(raw).get("error", {}) if raw.startswith("{") else {}
            if e.code == 429 and is_daily_quota(error):
                raise DailyQuota(model)
            if e.code == 429 or e.code >= 500:
                delay = retry_delay(error, 15 * attempt)
                print(f"    HTTP {e.code}, повтор через {delay} с", flush=True)
                time.sleep(delay)
                continue
            raise RuntimeError(f"HTTP {e.code}: {raw[:400]}")
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"    сеть: {e}, повтор", flush=True)
            time.sleep(15 * attempt)
    raise RuntimeError("API не отвечает после 6 попыток")


def tts(model, voice, prompt, purpose):
    if calls_today(model) >= DAILY_LIMIT:
        raise DailyQuota(model)
    body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"responseModalities": ["AUDIO"],
                                 "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}}}}
    data = post(model, body)
    log_usage(model, purpose, data.get("usageMetadata"))
    candidate = (data.get("candidates") or [{}])[0]
    parts = candidate.get("content", {}).get("parts", [])
    if not parts or "inlineData" not in parts[0]:
        raise QCError(f"нет аудио, finishReason={candidate.get('finishReason')}")
    raw = base64.b64decode(parts[0]["inlineData"]["data"])
    # 3.8 отдаёт WAV с заголовком, 3.1 — голый PCM.
    if raw[:4] == b"RIFF":
        with wave.open(io.BytesIO(raw)) as w:
            return w.readframes(w.getnframes()), w.getframerate()
    m = re.search(r"rate=(\d+)", parts[0]["inlineData"]["mimeType"])
    return raw, int(m.group(1)) if m else 24000


def write_wav(path, pcm, rate):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)


def read_wav(path):
    with wave.open(str(path)) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32768, w.getframerate()


def speech_mask(x, rate):
    n = max(1, int(rate * FRAME_S))
    frames = x[: len(x) - len(x) % n].reshape(-1, n)
    rms = np.sqrt((frames ** 2).mean(axis=1))
    if rms.max() == 0:
        raise QCError("пустое аудио")
    return rms >= rms.max() * 10 ** (SILENCE_DB / 20), n


def trim(x, rate):
    mask, n = speech_mask(x, rate)
    idx = np.flatnonzero(mask)
    if not len(idx):
        raise QCError("нет речи")
    start = max(0, idx[0] * n - int(rate * 0.03))
    end = min(len(x), (idx[-1] + 1) * n + int(rate * 0.08))
    clip = x[start:end].copy()
    fade = min(int(rate * 0.005), len(clip) // 2)
    if fade:
        ramp = np.linspace(0, 1, fade)
        clip[:fade] *= ramp
        clip[-fade:] *= ramp[::-1]
    return clip


def split_lines(x, rate, count):
    """Режет запись на count строк по count-1 самым длинным паузам."""
    mask, n = speech_mask(x, rate)
    idx = np.flatnonzero(mask)
    runs, start = [], None
    for i in range(idx[0], idx[-1] + 1):
        if not mask[i] and start is None:
            start = i
        elif mask[i] and start is not None:
            runs.append((i - start, start, i))
            start = None
    runs.sort(reverse=True)
    if len(runs) < count - 1:
        raise QCError(f"пауз {len(runs)}, нужно {count - 1}")
    chosen, rest = runs[: count - 1], runs[count - 1:]
    shortest = chosen[-1][0] * FRAME_S
    longest_rest = rest[0][0] * FRAME_S if rest else 0
    if shortest < MIN_GAP_S or longest_rest > shortest * AMBIGUOUS_GAP_RATIO:
        raise QCError(f"границы неоднозначны: кратчайшая пауза {shortest:.2f} с, следующая {longest_rest:.2f} с")
    cuts = [0] + [(a + b) // 2 * n for _, a, b in sorted(chosen, key=lambda r: r[1])] + [len(x)]
    clips = [trim(x[a:b], rate) for a, b in zip(cuts, cuts[1:])]
    for i, c in enumerate(clips, 1):
        if not 0.12 <= len(c) / rate <= 4.0:
            raise QCError(f"строка {i}: подозрительная длительность {len(c) / rate:.2f} с")
    return clips, {"shortest_gap_s": round(shortest, 3), "longest_inner_gap_s": round(longest_rest, 3)}


def build_prompt(plan, lines):
    _, persona, scene, performance = plan
    return (f"# AUDIO PROFILE: {persona}\n## THE SCENE: {scene}\n### DIRECTOR'S NOTES\n"
            f"Performance: {performance}. Stay fully in character on every single line and exaggerate it.\n"
            "Language: Russian. Read the transcript exactly as written and add nothing. Leave a brief pause after every line.\n"
            "#### TRANSCRIPT\n" + "\n\n".join(lines))


def obtain(round_no, name, model, voice, prompt, process):
    """Берёт ответ из кэша или запрашивает API; при браке запрашивает заново."""
    digest = hashlib.sha1(f"{model}|{voice}|{prompt}".encode()).hexdigest()[:8]
    raw_path = RAW_DIR / f"round_{round_no:02d}_{name}_{digest}.wav"
    blocked = rejected = 0
    while blocked < MAX_BLOCKED and rejected < MAX_REJECTED:
        if not raw_path.exists():
            print(f"  {name}: запрос к {model} ({voice})", flush=True)
            try:
                pcm, rate = tts(model, voice, prompt, f"round {round_no} {name}")
            except QCError as e:
                print(f"    отказ: {e}", flush=True)
                blocked += 1
                continue
            write_wav(raw_path, pcm, rate)
        x, rate = read_wav(raw_path)
        try:
            return process(x, rate), rate
        except QCError as e:
            print(f"    брак: {e}", flush=True)
            raw_path.rename(raw_path.with_suffix(f".rejected{int(time.time())}.wav"))
            rejected += 1
    raise QCError(f"раунд {round_no}, {name}: отказов {blocked}, брака {rejected}")


def voiced(clip, rate):
    mask, n = speech_mask(clip, rate)
    return clip[: len(mask) * n].reshape(-1, n)[mask].ravel()


def rms(x):
    return np.sqrt((x ** 2).mean())


def round_gain(clips, rate):
    peak = max(np.abs(c).max() for c in clips)
    return min(10 ** (TARGET_RMS_DB / 20) / rms(np.concatenate([voiced(c, rate) for c in clips])), PEAK_LIMIT / peak)


def to_pcm(x):
    return (np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes()


def write_mp3(path, pcm, rate):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "s16le", "-ar", str(rate), "-ac", "1", "-i", "-",
                    "-c:a", "libmp3lame", "-b:a", "96k", str(path)], input=pcm, check=True)


def ms(samples, rate):
    return round(samples * 1000 / rate)


def process_round(entry):
    round_no = entry["round"]
    plan = ROUND_PLAN[round_no - 1]
    model = model_for(round_no)
    voice = plan[0]
    print(f"Раунд {round_no}: {model} / {voice} / {plan[1]}", flush=True)

    lines = [t for n, item in zip(NUMBERS, entry["items"])
             for t in (f"{n}.", f"{SPEECH.get(item['word'], item['word'])}.")]
    (clips, gaps), rate = obtain(round_no, "dictation", model, voice, build_prompt(plan, lines),
                                 lambda x, r: split_lines(x, r, len(lines)))
    extras = {}
    for key, text in LINES.items():
        extras[key], extra_rate = obtain(round_no, key, model, voice, build_prompt(plan, [text]),
                                         lambda x, r: trim(x, r))
        if extra_rate != rate:
            raise QCError(f"раунд {round_no}: разная частота дискретизации")

    for cell, text in RETAKES.get(round_no, {}).items():
        clips[2 * cell - 1], _ = obtain(round_no, f"retake_{cell:02d}", model, voice, build_prompt(plan, [text]),
                                        lambda x, r: trim(x, r))

    gain = round_gain(clips + [v for k, v in extras.items() if k not in SUBSTITUTES], rate)
    clips = [c * gain for c in clips]
    level = {k: gain * rms(voiced(extras[SUBSTITUTES[k]], rate)) / rms(voiced(v, rate)) if k in SUBSTITUTES else gain
             for k, v in extras.items()}
    extras = {k: v * min(level[k], PEAK_LIMIT / np.abs(v).max()) for k, v in extras.items()}

    folder = ROUNDS_DIR / f"round_{round_no:02d}"
    pause = np.zeros(int(rate * PAUSE_S))
    track, cursor, cells = [], 0, []
    for i, item in enumerate(entry["items"]):
        n = item["cell_number"]
        number, word = clips[2 * i], clips[2 * i + 1]
        write_wav(folder / "numbers" / f"{n:02d}.wav", to_pcm(number), rate)
        write_wav(folder / "words" / f"{n:02d}.wav", to_pcm(word), rate)
        number_start = cursor
        word_start = number_start + len(number) + len(pause)
        cursor = word_start + len(word) + len(pause)
        track += [number, pause, word, pause]
        cells.append({"cell": n, "word": item["word"], "difficulty": item["difficulty"],
                      "number_clip": f"rounds/round_{round_no:02d}/numbers/{n:02d}.wav",
                      "word_clip": f"rounds/round_{round_no:02d}/words/{n:02d}.wav",
                      "number_start_ms": ms(number_start, rate), "number_ms": ms(len(number), rate),
                      "word_start_ms": ms(word_start, rate), "word_ms": ms(len(word), rate)})
    write_mp3(folder / "dictation.mp3", to_pcm(np.concatenate(track)), rate)
    service = {}
    for key, clip in extras.items():
        write_wav(folder / "lines" / f"{key}.wav", to_pcm(clip), rate)
        service[key] = {"text": LINES[key], "clip": f"rounds/round_{round_no:02d}/lines/{key}.wav", "ms": ms(len(clip), rate)}

    return {"round": round_no, "model": model, "voice": voice, "persona": plan[1], "scene": plan[2], "performance": plan[3],
            "sample_rate": rate, "pause_ms": round(PAUSE_S * 1000),
            "dictation": f"rounds/round_{round_no:02d}/dictation.mp3", "dictation_ms": ms(cursor, rate),
            "gain_db": round(20 * float(np.log10(gain)), 1), "segmentation": gaps, "lines": service, "cells": cells}


def load_json(path, default):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def save_json(path, data):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def parse_rounds(spec):
    if not spec:
        return list(range(1, len(ROUND_PLAN) + 1))
    out = []
    for part in spec.split(","):
        a, _, b = part.partition("-")
        out += range(int(a), int(b or a) + 1)
    return out


def rounds_data():
    return {r["round"]: r for r in json.loads(WORDS_FILE.read_text(encoding="utf-8"))["rounds"]}


def generate(rounds, force):
    data = rounds_data()
    manifest = load_json(MANIFEST, {"game_title": "Художник-склеротик", "rounds": {}})
    failed, blocked = [], set()
    for r in rounds:
        model = model_for(r)
        if str(r) in manifest["rounds"] and not force:
            print(f"Раунд {r}: уже готов", flush=True)
            continue
        # Устаревшая запись не должна остаться в манифесте, если раунд не соберётся.
        manifest["rounds"].pop(str(r), None)
        save_json(MANIFEST, manifest)
        if model in blocked:
            failed.append(r)
            continue
        try:
            manifest["rounds"][str(r)] = process_round(data[r])
            # Порядок раундов не должен зависеть от того, какие из них пересобирались.
            manifest["rounds"] = dict(sorted(manifest["rounds"].items(), key=lambda kv: int(kv[0])))
            save_json(MANIFEST, manifest)
        except DailyQuota:
            print(f"  дневной лимит {model} исчерпан, его раунды переносятся на завтра", flush=True)
            blocked.add(model)
            failed.append(r)
        except (QCError, RuntimeError) as e:
            print(f"  ОШИБКА: {e}", flush=True)
            failed.append(r)
    print("Не готовы раунды:", failed or "нет", flush=True)


def normalize(s):
    s = unicodedata.normalize("NFD", s.lower().replace("ё", "е"))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = unicodedata.normalize("NFC", s).replace("-", " ")
    return " ".join(re.sub(r"[^\w\s]", " ", s).split())


def verify(rounds):
    data = rounds_data()
    results = load_json(VERIFICATION, {})
    number_lookup = {normalize(w): str(i) for i, w in enumerate(NUMBERS, 1)}
    prompt = ("This Russian audio alternates a spoken number and a spoken word or phrase. Transcribe exactly what is heard, in order. "
              'Return JSON: {"items": [strings, one per spoken item, numbers as digits], '
              '"delivery": "under 15 English words on the speaker\'s emotion, energy and manner"}.')
    for r in rounds:
        track = ROUNDS_DIR / f"round_{r:02d}" / "dictation.mp3"
        if not track.exists():
            print(f"Раунд {r}: дорожки нет, пропускаю", flush=True)
            continue
        body = {"contents": [{"role": "user", "parts": [
                    {"inlineData": {"mimeType": "audio/mp3", "data": base64.b64encode(track.read_bytes()).decode()}}, {"text": prompt}]}],
                "generationConfig": {"responseMimeType": "application/json", "thinkingConfig": {"thinkingLevel": "low"}}}
        reply = post(VERIFY_MODEL, body)
        log_usage(VERIFY_MODEL, f"verify {r}", reply.get("usageMetadata"))
        parsed = json.loads(reply["candidates"][0]["content"]["parts"][-1]["text"])
        expected = [x for item in data[r]["items"] for x in (str(item["cell_number"]), normalize(item["word"]))]
        heard = [number_lookup.get(normalize(str(h)), normalize(str(h))) for h in parsed["items"]]
        diffs = [{"expected": expected[a:b], "heard": heard[c:d]}
                 for tag, a, b, c, d in difflib.SequenceMatcher(a=expected, b=heard, autojunk=False).get_opcodes() if tag != "equal"]
        results[str(r)] = {"heard_items": len(heard), "expected_items": len(expected), "diffs": diffs, "delivery": parsed.get("delivery")}
        save_json(VERIFICATION, results)
        print(f"Раунд {r}: услышано {len(heard)}/{len(expected)}, расхождений {len(diffs)}, манера: {parsed.get('delivery')}", flush=True)
        for d in diffs:
            print(f"    ожидалось {d['expected']} -> услышано {d['heard']}", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["generate", "verify"])
    parser.add_argument("--rounds", default="")
    parser.add_argument("--force", action="store_true", help="пересобрать готовые раунды (кэш API сохраняется)")
    args = parser.parse_args()
    if args.command == "generate":
        generate(parse_rounds(args.rounds), args.force)
    else:
        verify(parse_rounds(args.rounds))


if __name__ == "__main__":
    main()
