"""Обучающее видео «Как играть»: сцены из Gemini Omni 1.2 Flash, голос диктора из Gemini TTS.

Сценарий — SCRIPT.md, здесь те же сцены в виде данных. Omni снимает картинку и шумы студии,
говорить художнику запрещено: у отдельно снятых сцен голос каждый раз был бы другим.
Поэтому текст читает один диктор через TTS, а под всё подложена музыка игры.

    set GEMINI_API_KEY=...
    python -X utf8 make_tutorial.py voice              # озвучка сцен -> voice/
    python -X utf8 make_tutorial.py video --scenes 1   # сцены -> clips/ (≈ $0.07 за секунду 720p)
    python -X utf8 make_tutorial.py check              # есть ли в сценах речь или музыка
    python -X utf8 make_tutorial.py assemble           # склейка -> ../tutorial.mp4

Готовая сцена повторно не запрашивается; переснять: video --scenes 3 --retake,
поправить словами: edit --scene 4 --prompt "...". Прежний вариант сцены уходит в .state/rejected.
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
REFS = BASE / "refs"
UI = BASE / "ui"
VOICE_DIR = BASE / "voice"
CLIPS_DIR = BASE / "clips"
STATE = BASE / ".state"
USAGE_LOG = STATE / "usage_log.jsonl"
MUSIC = BASE.parent.parent / "music" / "Midday_at_the_Atelier.mp3"
OUTPUT = BASE.parent / "tutorial.mp4"

API = "https://generativelanguage.googleapis.com/v1beta"
VIDEO_MODEL = "gemini-omni-1.2-flash"
TTS_MODEL = "gemini-3.8-flash-tts"
CHECK_MODEL = "gemini-3.8-flash"
TTS_VOICE = "Laomedeia"
RESOLUTION = "720p"

# Голос вступает чуть позже начала сцены и заканчивается чуть раньше её конца.
LEAD_S = 0.5
TAIL_S = 0.7
SILENCE_DB = -45.0
# Шумы студии из Omni под голосом диктора; у сцены может быть своя громкость (ключ sfx).
SFX_VOLUME = 0.45

TTS_DIRECTION = (
    "# AUDIO PROFILE: Narrator of a funny animated tutorial\n"
    "## THE SCENE: A cozy art studio; you explain a drawing-and-memory game to a new player\n"
    "### DIRECTOR'S NOTES\n"
    "Performance: warm, playful and lively, like a storyteller in a family cartoon; smiling voice, crisp diction, "
    "a brisk but unhurried pace. Words in «» are what the game's announcer says: say them as a clear, slightly "
    "theatrical announcer, with a short pause between the number and the word.\n"
    "Language: Russian. Read the transcript exactly as written and add nothing.\n"
    "#### TRANSCRIPT\n"
)

STYLE = """Stylized 3D animated cartoon with the same look as the reference images: soft warm golden light, rich detail, cozy atmosphere. Vertical 9:16 framing.
SETTING: the artist's studio from the studio reference image: wooden plank floor, shelves with paint jars, a cork board with pinned sketches, rolled papers and a wooden easel with a large portrait canvas.
CHARACTER: the artist from the character reference image: a lanky young man with curly brown hair, a red beret, round wire glasses, a big nose, a blue-and-white striped shirt with rolled sleeves, a paint-splattered beige apron, dark trousers and worn brown boots. Keep his face and outfit identical.
THE CANVAS on the easel shows the game board from the board reference image: a 5 by 5 grid of white square cards with rounded corners on a beige background; each card has a small grey handwritten number in its top-left corner, from 1 to 25, left to right, top to bottom. The artist draws on the cards with a thick black marker; his drawings are simple bold black line doodles like in the board reference.
AUDIO: no dialogue, no voice-over, no singing, no music. The artist never speaks and keeps his mouth closed; he acts only with facial expressions and gestures. Only natural sound effects: marker squeaks on the canvas, footsteps on the wooden floor, soft room tone.
No subtitles, no captions and no on-screen text except what is described below."""

SCENES = [
    {
        "slug": "01-intro",
        "title": "Знакомство",
        "narration": "Это художник-склеротик. Рисует он лихо, а вот память… дырявая. Его холст — двадцать пять ячеек с номерами.",
        "refs": [REFS / "studio.jpg", REFS / "artist.jpg", UI / "board-empty.png"],
        "roles": "The first image is the opening frame: the empty studio. The second image is the artist. The third image is the game board that appears on the canvas.",
        "action": """Single continuous shot, no scene cuts.
[0-3s] The video opens exactly on the first image: the empty studio with a blank white canvas on the easel. The artist walks into the frame from the left with a black marker in his hand, cheerful and confident.
[3-6s] He stops in front of the canvas and lifts the marker to draw, then freezes: he has forgotten what he wanted to draw. He looks puzzled and scratches his head under the beret.
[6s-end] He shrugs, smiles and flicks the marker at the canvas: with a soft magical shimmer the blank canvas turns into the empty game board, the 5 by 5 grid of numbered cards. The camera slowly pushes in toward the board while the artist presents it with an open-hand gesture, like a showman.""",
    },
    {
        "slug": "02-dictation",
        "title": "Диктовка",
        "narration": "Голос называет номер ячейки, а через секунду — слово. «Семь… Кот!» Рисуйте кота в седьмой ячейке — она подсвечена.",
        "refs": [REFS / "artist.jpg", REFS / "studio.jpg", UI / "board-dictation-empty.png", UI / "cell-cat.png"],
        "roles": "The first image is the artist, the second is the studio. The third image is the board on the canvas at the start of the shot. The fourth image is the cat doodle he draws.",
        "action": """Single continuous shot, no scene cuts. Medium shot of the artist beside the easel; the canvas fills most of the frame. Cards 1 to 6 already have small doodles (sun, house, fish, tree, glasses, key), and card 7, the second card in the second row, is empty, exactly as in the third image.
[0-5s] The artist stands ready with the marker raised and listens intently, one hand cupped to his ear, eyes wide.
[5-7s] Card 7 lights up with a glowing orange-yellow outline. The artist nods quickly.
[7s-end] The camera moves closer to card 7. With a few quick, confident strokes of the thick black marker he draws a simple cat face inside card 7: a round head, two pointy ears, dot eyes, a little smile and whiskers, just like the fourth image. The marker squeaks. He finishes and taps the card proudly.""",
    },
    {
        "slug": "03-tempo",
        "title": "Темп",
        "narration": "Слова идут одно за другим — рисуйте быстро, хватит пары штрихов. После диктовки будет ещё тридцать секунд, чтобы дорисовать.",
        # Omni подложила сюда свою музыку вопреки промпту: прячем её под музыкой игры.
        "sfx": 0.15,
        "refs": [REFS / "artist.jpg", REFS / "studio.jpg", UI / "board-dictation.png", UI / "board-full.png"],
        "roles": "The first image is the artist, the second is the studio. The third image is the board at the start of the shot; the fourth image is the board at the end of the shot.",
        "action": """Single continuous shot, no scene cuts, energetic comedic pace.
[0-6s] Card after card on the canvas lights up with an orange outline, and the artist rushes from card to card, sketching a quick doodle in each in a second or two: an umbrella, a cup, a star, a heart, a ladder. His beret slips, his glasses slide down his nose, the marker squeaks fast. The board fills up with doodles.
[6s-end] The whole grid is full of doodles, like the fourth image. The artist steps back, out of breath, pulls a big old-fashioned stopwatch from his apron pocket, glances at it, then darts back to add one last stroke to a drawing.""",
    },
    {
        "slug": "04-quiz",
        "title": "Опрос",
        "narration": "Потом голос спросит про девять ячеек: «Что было в ячейке номер семь?» Посмотрите на рисунок, вспомните слово и впишите его. Верно — плюс балл!",
        "refs": [REFS / "artist.jpg", UI / "board-full.png", UI / "cell-cat.png"],
        "roles": "The first image is the artist. The second image is the board on the canvas, full of doodles. The third image is the cat doodle on card 7.",
        "action": """Single continuous shot, no scene cuts. Close shot of the artist and the canvas full of doodles, like the second image.
[0-5s] Card 7 with the cat doodle glows with an orange outline and all the other cards dim a little. The artist leans in very close to it, squinting through his round glasses and rubbing his chin, puzzled: what was this word?
[5-9s] His face lights up: he remembers! He snaps his fingers with a big smile.
[9s-end] A big bright green "+1" pops up next to the cat card with a cheerful chime and a few sparkles. The artist pumps his fist with joy.""",
    },
    {
        "slug": "05-finale",
        "title": "Ошибка и финал",
        "narration": "Ошиблись или не вспомнили — минус балл. Так что рисуйте понятно! Готовы? Берите маркер!",
        "refs": [REFS / "artist.jpg", REFS / "studio.jpg", UI / "board-full.png"],
        "roles": "The first image is the artist, the second is the studio, the third is the board on the canvas.",
        "action": """Single continuous shot, no scene cuts.
[0-2s] The artist peers at card 8 with the umbrella doodle, unsure, and shrugs.
[2-4s] A red "-1" pops up next to the card with a soft comic bonk, and he winces comically.
[4-6s] He turns to the camera and smiles warmly.
[6s-end] He holds the black marker out toward the viewer, offering it, and winks. The camera gently pushes in on his friendly face.""",
    },
]


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
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32768, w.getframerate()


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


def voice_path(scene):
    return VOICE_DIR / f"{scene['slug']}.wav"


def voice_seconds(scene):
    x, rate = read_wav(voice_path(scene))
    return len(x) / rate


def scene_seconds(scene):
    """Длина сцены в целых секундах (так её принимает Omni): голос плюс поля."""
    return min(15, max(3, math.ceil(LEAD_S + voice_seconds(scene) + TAIL_S)))


def cmd_voice(args):
    for i, scene in enumerate(SCENES, 1):
        path = voice_path(scene)
        if path.exists() and i not in args.retake:
            print(f"{scene['slug']}: {voice_seconds(scene):.1f} с (готово)")
            continue
        print(f"{scene['slug']}: запрос к {TTS_MODEL} ({TTS_VOICE})", flush=True)
        x, rate = tts(scene["narration"])
        x = trim(x, rate)
        x *= 10 ** (-1 / 20) / max(1e-9, np.abs(x).max())
        write_wav(path, x, rate)
        print(f"  {voice_seconds(scene):.1f} с голоса -> сцена {scene_seconds(scene)} с")


# ——— Видео ———

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


def cmd_assemble(args):
    clips = [clip_path(s) for s in SCENES]
    missing = [c.name for c in clips if not c.exists()]
    if missing:
        sys.exit(f"Нет сцен: {', '.join(missing)}")
    inputs, video, sfx, voices = [], [], [], []
    offset = 0.0
    for i, (scene, clip) in enumerate(zip(SCENES, clips)):
        seconds, has_audio = probe(clip)
        inputs += ["-i", str(clip)]
        video.append(f"[{i}:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1,fps=24,"
                     f"trim=duration={seconds:.3f},setpts=PTS-STARTPTS[v{i}]")
        if has_audio:
            sfx.append(f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration={seconds:.3f},asetpts=PTS-STARTPTS,"
                       f"volume={scene.get('sfx', SFX_VOLUME)}[s{i}]")
        else:
            sfx.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={seconds:.3f}[s{i}]")
        voices.append((voice_path(scene), offset + LEAD_S))
        offset += seconds
    n = len(clips)
    for k, (path, start) in enumerate(voices):
        inputs += ["-i", str(path)]
        ms = int(start * 1000)
        sfx.append(f"[{n + k}:a]aresample=48000,aformat=channel_layouts=stereo,adelay={ms}|{ms}[n{k}]")
    inputs += ["-i", str(MUSIC)]
    total = offset
    graph = ";".join(video + sfx + [
        "".join(f"[v{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=0,fade=in:d=0.3,fade=out:st={total - 0.6:.3f}:d=0.6[v]",
        "".join(f"[s{i}]" for i in range(n)) + f"concat=n={n}:v=0:a=1[sfx]",
        "".join(f"[n{k}]" for k in range(n)) + f"amix=inputs={n}:normalize=0,apad,atrim=duration={total:.3f}[voice]",
        f"[{2 * n}:a]aresample=48000,atrim=duration={total:.3f},volume=0.16,afade=in:d=1,afade=out:st={total - 1.5:.3f}:d=1.5[music]",
        "[voice][sfx][music]amix=inputs=3:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a]",
    ])
    cmd = ["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex", graph, "-map", "[v]", "-map", "[a]",
           "-c:v", "libx264", "-preset", "slow", "-crf", "24", "-pix_fmt", "yuv420p", "-r", "24",
           "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(OUTPUT)]
    subprocess.run(cmd, check=True)
    print(f"{OUTPUT.name}: {total:.1f} с, {OUTPUT.stat().st_size / 1e6:.1f} МБ")


def scene_list(text):
    return {int(x) for x in text.split(",") if x}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("voice")
    p.add_argument("--retake", type=scene_list, default=set(), help="переозвучить сцены, например 2,4")
    p = sub.add_parser("video")
    p.add_argument("--scenes", type=scene_list, default=set(), help="номера сцен, например 1,3")
    p.add_argument("--retake", action="store_true", help="переснять готовые сцены")
    p = sub.add_parser("edit")
    p.add_argument("--scene", type=int, required=True, help="номер сцены")
    p.add_argument("--prompt", required=True, help="что изменить, например: Make the card number 7")
    p = sub.add_parser("check")
    p.add_argument("--scenes", type=scene_list, default=set(), help="номера сцен, например 1,3")
    sub.add_parser("assemble")
    args = parser.parse_args()
    {"voice": cmd_voice, "video": cmd_video, "edit": cmd_edit, "check": cmd_check, "assemble": cmd_assemble}[args.cmd](args)


if __name__ == "__main__":
    main()
