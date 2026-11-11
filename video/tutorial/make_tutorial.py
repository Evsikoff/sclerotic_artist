"""Обучающее видео «Как играть»: художник из Gemini Omni 1.2 Flash и запись настоящего экрана игры.

Сценарий — SCRIPT.md. Начало и конец снимает Omni: художник в студии, говорить ему запрещено,
текст читает один диктор через Gemini TTS. Середина — запись настоящей игры (record_ui.mjs):
«палец» касается ячеек и кнопок, а диктор объясняет каждое действие. Под всё подложена музыка игры.

    set GEMINI_API_KEY=...
    python -X utf8 make_tutorial.py voice              # озвучка -> voice/ и voice/lines.json
    python -X utf8 make_tutorial.py record             # запись экрана (нужен npm run dev) -> clips/02-gameplay.*
    python -X utf8 make_tutorial.py video --scenes 1   # сцены Omni -> clips/ (≈ $0.07 за секунду 720p)
    python -X utf8 make_tutorial.py check              # есть ли в сценах Omni речь или музыка
    python -X utf8 make_tutorial.py assemble           # склейка -> ../tutorial.mp4

Готовая сцена повторно не запрашивается; переснять: video --scenes 2 --retake,
поправить словами: edit --scene 1 --prompt "...". Прежний вариант сцены уходит в .state/rejected.
"""
import argparse
import base64
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import wave
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

BASE = Path(__file__).resolve().parent
ROOT = BASE.parent.parent
REFS = BASE / "refs"
VOICE_DIR = BASE / "voice"
CLIPS_DIR = BASE / "clips"
STATE = BASE / ".state"
USAGE_LOG = STATE / "usage_log.jsonl"
RECORDING = STATE / "ui"
MUSIC = ROOT / "music" / "Midday_at_the_Atelier.mp3"
ROUND_AUDIO = ROOT / "voiceover" / "rounds" / "round_10"
OUTPUT = BASE.parent / "tutorial.mp4"
GAMEPLAY = CLIPS_DIR / "02-gameplay.mp4"
GAMEPLAY_EVENTS = CLIPS_DIR / "02-gameplay.json"
LINES_JSON = VOICE_DIR / "lines.json"

API = "https://generativelanguage.googleapis.com/v1beta"
VIDEO_MODEL = "gemini-omni-1.2-flash"
TTS_MODEL = "gemini-3.8-flash-tts"
CHECK_MODEL = "gemini-3.8-flash"
TTS_VOICE = "Laomedeia"
RESOLUTION = "720p"
FPS = 30
WIDTH, HEIGHT = 720, 1280

# В сценах Omni голос вступает чуть позже начала и заканчивается чуть раньше конца.
LEAD_S = 0.5
TAIL_S = 0.7
SILENCE_DB = -45.0
# Шумы студии из Omni под голосом диктора; у сцены может быть своя громкость (ключ sfx).
SFX_VOLUME = 0.45
# Склейка Omni и записи экрана — наплывом.
CROSSFADE_S = 0.4
GAME_VOICE_VOLUME = 0.9
MUSIC_VOLUME = 0.14

TTS_DIRECTION = (
    "# AUDIO PROFILE: Narrator of a funny animated tutorial\n"
    "## THE SCENE: A cozy art studio; you explain a drawing-and-memory game to a new player\n"
    "### DIRECTOR'S NOTES\n"
    "Performance: warm, playful and lively, like a storyteller in a family cartoon; smiling voice, crisp diction, "
    "a brisk but unhurried pace. Words in «» are names of on-screen buttons: say them clearly with a light emphasis.\n"
    "Language: Russian. Read the transcript exactly as written and add nothing.\n"
    "#### TRANSCRIPT\n"
)

STYLE = """Stylized 3D animated cartoon with the same look as the reference images: soft warm golden light, rich detail, cozy atmosphere. Vertical 9:16 framing.
SETTING: the artist's studio from the studio reference image: wooden plank floor, shelves with paint jars, a cork board with pinned sketches, rolled papers and a wooden easel with a large portrait canvas.
CHARACTER: the artist from the character reference image: a lanky young man with curly brown hair, a red beret, round wire glasses, a big nose, a blue-and-white striped shirt with rolled sleeves, a paint-splattered beige apron, dark trousers and worn brown boots. Keep his face and outfit identical.
THE PHONE: a modern smartphone in a plain dark case. Its screen shows the game from the phone screen reference image: a 5 by 5 grid of white square cards with small handwritten numbers on a beige background, a light top bar and a row of round buttons at the bottom.
AUDIO: no dialogue, no voice-over, no singing, no music. The artist never speaks and keeps his mouth closed; he acts only with facial expressions and gestures. Only natural sound effects: marker squeaks, footsteps on the wooden floor, cloth rustle, soft room tone.
No subtitles, no captions and no on-screen text."""

# Сцены Omni. Между ними — запись экрана (clips/02-gameplay.mp4).
SCENES = [
    {
        "slug": "01-intro",
        "title": "Знакомство",
        "narration": "Это художник-склеротик. Рисует он лихо, а вот память — дырявая! Сейчас покажу, как играть.",
        "min_seconds": 8,
        "refs": [REFS / "studio.jpg", REFS / "artist.jpg", REFS / "phone-screen.png"],
        "roles": "The first image is the opening frame: the studio. The second image is the artist. "
                 "The third image is what the smartphone screen shows.",
        "action": """Single continuous shot, no scene cuts.
[0-3s] The video opens exactly on the first image: the studio with a blank canvas on the easel. The artist walks into the frame from the left with a black marker, raises it to draw on the blank canvas, then freezes: he has forgotten what he wanted to draw. He looks puzzled and scratches his head under the beret.
[3-5s] An idea: he pulls a smartphone out of his apron pocket, looks at its screen and smiles brightly.
[5s-end] He turns the phone toward the camera and holds it up at arm's length. The camera pushes in smoothly until the phone screen, showing the game from the third image, fills most of the frame.""",
    },
    {
        "slug": "03-finale",
        "title": "Финал",
        "narration": "Так что рисуйте понятно — и память не подведёт! Готовы? Берите маркер!",
        "min_seconds": 7,
        "refs": [REFS / "artist.jpg", REFS / "studio.jpg", REFS / "phone-screen.png"],
        "roles": "The first image is the artist, the second is the studio, the third is what the smartphone screen shows.",
        "action": """Single continuous shot, no scene cuts.
[0-2s] Medium close shot: the artist looks at the smartphone in his hand, winces comically and slaps his forehead, as if he has just forgotten a word.
[2-4s] He laughs it off, slips the phone into his apron pocket and picks up a thick black marker from the easel.
[4s-end] He turns to the camera, smiles warmly, holds the marker out toward the viewer, offering it, and winks. The camera gently pushes in on his friendly face.""",
    },
]

# Реплики диктора к записи экрана; когда какая звучит, решает record_ui.mjs.
UI_LINES = {
    "board": "Вот поле: двадцать пять ячеек с номерами.",
    "number": "Голос называет номер — и ячейка загорается…",
    "word": "…а следом звучит слово. Его и рисуем!",
    "zoom": "Коснитесь ячейки — она приблизится.",
    "draw": "Рисуйте прямо пальцем.",
    "oops": "Лишняя линия?",
    "undo": "«Отменить» уберёт последнюю.",
    "next": "Стрелка — к следующей ячейке.",
    "zoomout": "«Отдалить» — снова всё поле.",
    "speaker": "Отстали от голоса? Кнопка с динамиком перенесёт к ячейке, о которой он уже договорил.",
    "final": "Список закончился? Есть ещё тридцать секунд, чтобы дорисовать.",
    "done": "Закончили раньше — жмите «Готово».",
    "quiz": "Потом голос спросит про девять ячеек. Вспомните слово и впишите его.",
    "right": "Верно — плюс балл!",
    "wrong": "Не вспомнили или ошиблись — минус балл.",
}


# ——— API ———

def api_key():
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        sys.exit("Нужна переменная окружения GEMINI_API_KEY")
    return key


def request(url, body=None, timeout=900, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json", "x-goog-api-key": api_key()})
    for attempt in range(1, 5):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                payload = r.read()
                return payload if raw else json.loads(payload)
        except urllib.error.HTTPError as e:
            text = e.read().decode(errors="replace")
            if e.code == 429 or e.code >= 500:
                print(f"    HTTP {e.code}, повтор через {20 * attempt} с: {text[:200]}", flush=True)
                time.sleep(20 * attempt)
                continue
            raise RuntimeError(f"HTTP {e.code}: {text[:1000]}")
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"    сеть: {e}, повтор", flush=True)
            time.sleep(20 * attempt)
    raise RuntimeError("API не отвечает")


def log_usage(model, purpose, usage):
    STATE.mkdir(parents=True, exist_ok=True)
    row = {"time": datetime.now(timezone.utc).isoformat(timespec="seconds"), "model": model, "purpose": purpose, "usage": usage}
    with USAGE_LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def image_part(path):
    mime = "image/png" if path.suffix == ".png" else "image/jpeg"
    return {"type": "image", "data": base64.b64encode(path.read_bytes()).decode(), "mime_type": mime}


# ——— Озвучка ———

def read_wav(path):
    with wave.open(str(path)) as w:
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32768
        return x.reshape(-1, w.getnchannels()).mean(axis=1), w.getframerate()


def write_wav(path, x, rate):
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = (np.clip(x, -1, 1) * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


def trim(x, rate):
    """Срезает тишину по краям, оставляя по 50 мс."""
    n = int(rate * 0.01)
    frames = x[: len(x) - len(x) % n].reshape(-1, n)
    loud = np.flatnonzero(np.sqrt((frames ** 2).mean(axis=1)) >= 10 ** (SILENCE_DB / 20))
    pad = 5
    start = max(0, loud[0] - pad) * n
    end = min(len(frames), loud[-1] + 1 + pad) * n
    return x[start:end]


def tts(text):
    body = {"contents": [{"role": "user", "parts": [{"text": TTS_DIRECTION + text}]}],
            "generationConfig": {"responseModalities": ["AUDIO"],
                                 "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": TTS_VOICE}}}}}
    data = request(f"{API}/models/{TTS_MODEL}:generateContent", body, timeout=300)
    log_usage(TTS_MODEL, "tutorial voice", data.get("usageMetadata"))
    part = data["candidates"][0]["content"]["parts"][0]["inlineData"]
    raw = base64.b64decode(part["data"])
    if raw[:4] == b"RIFF":
        tmp = STATE / "tts.wav"
        STATE.mkdir(parents=True, exist_ok=True)
        tmp.write_bytes(raw)
        return read_wav(tmp)
    rate = int(re.search(r"rate=(\d+)", part["mimeType"]).group(1))
    return np.frombuffer(raw, dtype=np.int16).astype(np.float64) / 32768, rate


def all_lines():
    """Все реплики диктора: {id: текст}. У сцен Omni id — slug, у записи экрана — ui-<ключ>."""
    return {**{s["slug"]: s["narration"] for s in SCENES}, **{f"ui-{k}": v for k, v in UI_LINES.items()}}


def voice_path(line_id):
    return VOICE_DIR / f"{line_id}.wav"


def voice_seconds(line_id):
    x, rate = read_wav(voice_path(line_id))
    return len(x) / rate


def scene_seconds(scene):
    """Длина сцены Omni в целых секундах (так её принимает Omni): голос плюс поля."""
    return min(15, max(scene.get("min_seconds", 3), math.ceil(LEAD_S + voice_seconds(scene["slug"]) + TAIL_S)))


def cmd_voice(args):
    lines = all_lines()
    for line_id, text in lines.items():
        path = voice_path(line_id)
        if path.exists() and line_id not in args.retake:
            continue
        print(f"{line_id}: запрос к {TTS_MODEL} ({TTS_VOICE})", flush=True)
        x, rate = tts(text)
        x = trim(x, rate)
        x *= 10 ** (-1 / 20) / max(1e-9, np.abs(x).max())
        write_wav(path, x, rate)
    durations = {line_id: round(voice_seconds(line_id), 3) for line_id in lines}
    LINES_JSON.write_text(json.dumps(durations, ensure_ascii=False, indent=1), encoding="utf-8")
    for line_id, seconds in durations.items():
        print(f"{line_id}: {seconds:.1f} с")


# ——— Запись экрана ———

def cmd_record(args):
    """Записывает игру (record_ui.mjs) и собирает из кадров clips/02-gameplay.mp4 и события к нему."""
    if not args.render_only:
        subprocess.run(["node", str(BASE / "record_ui.mjs"), args.url], check=True)
    timeline = json.loads((RECORDING / "timeline.json").read_text(encoding="utf-8"))
    frames = timeline["frames"]
    parts, events, offset = [], [], 0.0
    for k, seg in enumerate(timeline["segments"]):
        start, end = seg["start"], seg["end"]
        # Кадр приходит, только когда экран меняется: первый кадр отрезка — последний перед его началом.
        first = max(i for i, f in enumerate(frames) if f["t"] <= start)
        chosen = [f for f in frames[first:] if f["t"] < end]
        lines = []
        for i, f in enumerate(chosen):
            t0 = max(f["t"], start)
            t1 = chosen[i + 1]["t"] if i + 1 < len(chosen) else end
            lines += [f"file '{(RECORDING / 'frames' / f['file']).as_posix()}'", f"duration {t1 - t0:.4f}"]
        lines.append(f"file '{(RECORDING / 'frames' / chosen[-1]['file']).as_posix()}'")
        listing = RECORDING / f"segment-{k}.txt"
        listing.write_text("\n".join(lines) + "\n", encoding="utf-8")
        part = RECORDING / f"segment-{k}.mp4"
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(listing),
                        "-vf", f"fps={FPS},scale={WIDTH}:{HEIGHT},setsar=1", "-t", f"{end - start:.3f}",
                        "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", str(part)], check=True)
        parts.append(part)
        for e in timeline["events"]:
            if start <= e["t"] < end:
                events.append({**e, "t": round(offset + e["t"] - start, 3)})
        print(f"  отрезок {seg['name']}: {end - start:.1f} с, кадров {len(chosen)}")
        offset += end - start
    listing = RECORDING / "segments.txt"
    listing.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts), encoding="utf-8")
    CLIPS_DIR.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy",
                    "-movflags", "+faststart", str(GAMEPLAY)], check=True)
    GAMEPLAY_EVENTS.write_text(json.dumps({"duration": round(offset, 3), "events": events}, ensure_ascii=False, indent=1),
                               encoding="utf-8")
    print(f"{GAMEPLAY.name}: {offset:.1f} с, событий {len(events)}")


# ——— Видео Omni ———

def scene_prompt(scene):
    seconds = scene_seconds(scene)
    return f"{scene['roles']}\n\n{STYLE}\n\nACTION ({seconds} seconds):\n{scene['action']}"


def download_video(item, dest):
    if item.get("data"):
        dest.write_bytes(base64.b64decode(item["data"]))
        return
    uri = item["uri"]
    file_id = re.search(r"files/([^:/?]+)", uri).group(1)
    for _ in range(120):
        state = request(f"{API}/files/{file_id}", timeout=60).get("state")
        if state == "ACTIVE":
            break
        if state == "FAILED":
            raise RuntimeError("Files API: FAILED")
        time.sleep(5)
    dest.write_bytes(request(uri, timeout=600, raw=True))


def interact(scene, body, prompt):
    """Один запрос к Omni; ответ без самого видео сохраняется в .state/<сцена>.json, видео — в clips/."""
    started = time.time()
    data = request(f"{API}/interactions", body)
    log_usage(VIDEO_MODEL, scene["slug"], data.get("usage"))
    STATE.mkdir(parents=True, exist_ok=True)
    meta = {k: v for k, v in data.items() if k != "steps"}
    meta["prompt"] = prompt
    meta["thoughts"] = [c.get("text") for s in data.get("steps", []) if s.get("type") == "thought" for c in s.get("content", [])]
    (STATE / f"{scene['slug']}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    videos = [c for s in data.get("steps", []) if s.get("type") == "model_output"
              for c in s.get("content", []) if c.get("type") == "video"]
    if not videos:
        raise RuntimeError(f"нет видео: status={data.get('status')}, {json.dumps(meta, ensure_ascii=False)[:800]}")
    dest = clip_path(scene)
    if dest.exists():
        rejected = STATE / "rejected"
        rejected.mkdir(parents=True, exist_ok=True)
        dest.rename(rejected / f"{scene['slug']}-{int(time.time())}.mp4")
    dest.parent.mkdir(parents=True, exist_ok=True)
    download_video(videos[0], dest)
    print(f"  готово за {time.time() - started:.0f} с: {dest.name}, {dest.stat().st_size / 1e6:.1f} МБ", flush=True)


def response_format(seconds=None):
    fmt = {"type": "video", "aspect_ratio": "9:16", "resolution": RESOLUTION, "delivery": "uri"}
    if seconds:
        fmt["duration"] = f"{seconds}s"
    return fmt


def clip_path(scene):
    return CLIPS_DIR / f"{scene['slug']}.mp4"


def cmd_video(args):
    for i, scene in enumerate(SCENES, 1):
        if args.scenes and i not in args.scenes:
            continue
        if clip_path(scene).exists() and not args.retake:
            print(f"{scene['slug']}: уже есть")
            continue
        seconds = scene_seconds(scene)
        prompt = scene_prompt(scene)
        body = {"model": VIDEO_MODEL, "input": [*(image_part(p) for p in scene["refs"]), {"type": "text", "text": prompt}],
                "response_format": response_format(seconds)}
        print(f"{scene['slug']}: запрос к {VIDEO_MODEL}, {seconds} с {RESOLUTION}", flush=True)
        interact(scene, body, prompt)


def cmd_edit(args):
    """Правка готовой сцены словами: Omni помнит её по id прошлого запроса."""
    scene = SCENES[args.scene - 1]
    previous = json.loads((STATE / f"{scene['slug']}.json").read_text(encoding="utf-8"))["id"]
    body = {"model": VIDEO_MODEL, "previous_interaction_id": previous, "input": args.prompt, "response_format": response_format()}
    print(f"{scene['slug']}: правка в {VIDEO_MODEL}: {args.prompt}", flush=True)
    interact(scene, body, args.prompt)


def cmd_check(args):
    """Omni должна дать только шумы: просим другую модель послушать каждую сцену."""
    question = ("Listen to the audio track of this video. Is there any human speech, singing, humming or music? "
                "If there is speech, transcribe it. Then list the sound effects you hear. Answer briefly.")
    for i, scene in enumerate(SCENES, 1):
        path = clip_path(scene)
        if not path.exists() or args.scenes and i not in args.scenes:
            continue
        body = {"contents": [{"role": "user", "parts": [
            {"inlineData": {"mimeType": "video/mp4", "data": base64.b64encode(path.read_bytes()).decode()}},
            {"text": question}]}]}
        data = request(f"{API}/models/{CHECK_MODEL}:generateContent", body, timeout=300)
        log_usage(CHECK_MODEL, f"check {scene['slug']}", data.get("usageMetadata"))
        text = "".join(p.get("text", "") for p in data["candidates"][0]["content"]["parts"])
        print(f"— {scene['slug']}:\n{text.strip()}\n")


# ——— Склейка ———

def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", str(path)],
                         capture_output=True, text=True, check=True).stdout
    info = json.loads(out)
    return float(info["format"]["duration"]), any(s["codec_type"] == "audio" for s in info["streams"])


SFX_RATE = 48000


def tone(freq, at, duration, kind, volume, out):
    """Повторяет audio.ts: звук с атакой 10 мс и экспоненциальным затуханием."""
    n = int(duration * SFX_RATE)
    t = np.arange(n) / SFX_RATE
    phase = freq * t
    wave_ = {"sine": np.sin(2 * np.pi * phase), "square": np.sign(np.sin(2 * np.pi * phase)),
             "sawtooth": 2 * (phase - np.floor(phase + 0.5)), "triangle": 2 * np.abs(2 * (phase - np.floor(phase + 0.5))) - 1}[kind]
    env = np.where(t < 0.01, t / 0.01 * volume, volume * (0.0001 / volume) ** ((t - 0.01) / max(1e-6, duration - 0.01)))
    start = int(at * SFX_RATE)
    out[start:start + n] += wave_ * env


def sfx_wav(kind):
    """Звуки игры (correct, wrong, tick) — те же тоны, что в src/audio.ts."""
    path = STATE / "sfx" / f"{kind}.wav"
    if not path.exists():
        out = np.zeros(int(0.6 * SFX_RATE))
        notes = {"correct": [(784, 0, 0.14, "sine", 0.22), (1175, 0.1, 0.3, "sine", 0.22)],
                 "wrong": [(233, 0, 0.18, "sawtooth", 0.07), (175, 0.15, 0.32, "sawtooth", 0.07)],
                 "tick": [(1250, 0, 0.06, "square", 0.05)]}[kind]
        for note in notes:
            tone(*note, out)
        write_wav(path, out, SFX_RATE)
    return path


def game_clip(event):
    """Голос раунда для события записи: файл и отрезок в нём (секунды)."""
    if event["type"] == "dictation":
        return ROUND_AUDIO / "dictation.mp3", event["offset"], event["duration"]
    path = ROUND_AUDIO / event["file"]
    return path, 0.0, None


def cmd_assemble(args):
    intro, finale = (clip_path(s) for s in SCENES)
    missing = [p.name for p in (intro, GAMEPLAY, finale) if not p.exists()]
    if missing:
        sys.exit(f"Нет частей: {', '.join(missing)}")
    gameplay = json.loads(GAMEPLAY_EVENTS.read_text(encoding="utf-8"))
    d_intro, _ = probe(intro)
    d_game, _ = probe(GAMEPLAY)
    d_finale, _ = probe(finale)
    t_game = d_intro - CROSSFADE_S
    t_finale = t_game + d_game - CROSSFADE_S
    total = t_finale + d_finale

    inputs = ["-i", str(intro), "-i", str(GAMEPLAY), "-i", str(finale)]
    norm = f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase,crop={WIDTH}:{HEIGHT},setsar=1,fps={FPS},format=yuv420p"
    graph = [
        f"[0:v]{norm},trim=duration={d_intro:.3f},setpts=PTS-STARTPTS[v0]",
        f"[1:v]{norm},trim=duration={d_game:.3f},setpts=PTS-STARTPTS[v1]",
        f"[2:v]{norm},trim=duration={d_finale:.3f},setpts=PTS-STARTPTS[v2]",
        f"[v0][v1]xfade=transition=fade:duration={CROSSFADE_S}:offset={t_game:.3f}[v01]",
        f"[v01][v2]xfade=transition=fade:duration={CROSSFADE_S}:offset={t_finale:.3f},"
        f"fade=in:d=0.3,fade=out:st={total - 0.6:.3f}:d=0.6[v]",
    ]

    # Звук: шумы студии из сцен Omni, диктор, голос раунда, звуки игры и музыка.
    layers = []

    def add(path, at, volume=1.0, offset=0.0, duration=None):
        k = len(inputs) // 2
        inputs.extend(["-i", str(path)])
        ms = max(0, int(round(at * 1000)))
        cut = f"atrim=start={offset:.3f}" + (f":duration={duration:.3f}" if duration else "") + ",asetpts=PTS-STARTPTS,"
        graph.append(f"[{k}:a]aresample=48000,aformat=channel_layouts=stereo,{cut}volume={volume},adelay={ms}|{ms}[a{len(layers)}]")
        layers.append(f"[a{len(layers)}]")

    for scene, at, length in ((SCENES[0], 0.0, d_intro), (SCENES[1], t_finale, d_finale)):
        if probe(clip_path(scene))[1]:
            add(clip_path(scene), at, scene.get("sfx", SFX_VOLUME), duration=length)
        add(voice_path(scene["slug"]), at + LEAD_S)
    for e in gameplay["events"]:
        at = t_game + e["t"]
        if e["type"] == "line":
            add(voice_path(f"ui-{e['id']}"), at)
        elif e["type"] == "sfx":
            add(sfx_wav(e["kind"]), at, 0.8)
        else:
            path, offset, duration = game_clip(e)
            add(path, at, GAME_VOICE_VOLUME, offset, duration)
    k = len(inputs) // 2
    inputs.extend(["-i", str(MUSIC)])
    graph.append(f"[{k}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration={total:.3f},volume={MUSIC_VOLUME},"
                 f"afade=in:d=1,afade=out:st={total - 1.5:.3f}:d=1.5[music]")
    graph.append("".join(layers) + f"[music]amix=inputs={len(layers) + 1}:normalize=0,apad,atrim=duration={total:.3f},"
                 "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a]")

    script = STATE / "assemble.filter"
    script.write_text(";\n".join(graph), encoding="utf-8")
    cmd = ["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex_script", str(script), "-map", "[v]", "-map", "[a]",
           "-c:v", "libx264", "-preset", "slow", "-crf", "23", "-pix_fmt", "yuv420p", "-r", str(FPS),
           "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(OUTPUT)]
    subprocess.run(cmd, check=True)
    print(f"{OUTPUT.name}: {total:.1f} с, {OUTPUT.stat().st_size / 1e6:.1f} МБ")


def scene_list(text):
    return {int(x) for x in text.split(",") if x}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("voice")
    p.add_argument("--retake", type=lambda s: set(s.split(",")), default=set(), help="переозвучить реплики, например ui-done,01-intro")
    p = sub.add_parser("record")
    p.add_argument("--url", default="http://127.0.0.1:5173/", help="адрес npm run dev")
    p.add_argument("--render-only", action="store_true", help="не записывать заново, только пересобрать клип из кадров")
    p = sub.add_parser("video")
    p.add_argument("--scenes", type=scene_list, default=set(), help="номера сцен Omni, например 1,2")
    p.add_argument("--retake", action="store_true", help="переснять готовые сцены")
    p = sub.add_parser("edit")
    p.add_argument("--scene", type=int, required=True, help="номер сцены Omni")
    p.add_argument("--prompt", required=True, help="что изменить словами")
    p = sub.add_parser("check")
    p.add_argument("--scenes", type=scene_list, default=set(), help="номера сцен Omni, например 1,2")
    sub.add_parser("assemble")
    args = parser.parse_args()
    {"voice": cmd_voice, "record": cmd_record, "video": cmd_video, "edit": cmd_edit, "check": cmd_check,
     "assemble": cmd_assemble}[args.cmd](args)


if __name__ == "__main__":
    main()
