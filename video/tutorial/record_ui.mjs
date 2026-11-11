/**
 * Запись настоящего экрана игры для обучающего ролика: раунд 10 в dev-сборке, телефон 360×640 при DPR 2 (720×1280).
 * «Палец» — кружок поверх страницы: касается ячеек и кнопок, рисует. Диктор (voice/ui-*.wav) объясняет каждое действие,
 * а когда какая реплика звучит, видно из .state/ui/timeline.json — по нему make_tutorial.py собирает звук.
 *
 *     npm run dev
 *     node video/tutorial/record_ui.mjs http://127.0.0.1:5173/
 *
 * Звук страница не пишет: голос раунда, звуки игры и диктор накладываются при склейке по событиям из timeline.json.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const BASE = dirname(fileURLToPath(import.meta.url));
const APP_URL = process.argv[2] ?? 'http://127.0.0.1:5173/';
const OUT = join(BASE, '.state', 'ui');
const FRAMES = join(OUT, 'frames');
const PHONE_REF = join(BASE, 'refs', 'phone-screen.png');
const LINES = JSON.parse(readFileSync(join(BASE, 'voice', 'lines.json'), 'utf8'));
const MANIFEST = JSON.parse(readFileSync(join(BASE, '..', '..', 'voiceover', 'manifest.json'), 'utf8'));

const ROUND = 10;
const TIMING = [...MANIFEST.rounds[ROUND].cells].sort((a, b) => a.cell - b.cell);
// Геометрия поля из src/board.ts: ячейка 100×100, щель 12, поля 16.
const CELL = 100;
const GAP = 12;
const PAD = 16;
const GRID = 5;

// ——— Рисунки: линии в координатах ячейки 0…100, номер ячейки — в левом верхнем углу ———

const TAU = Math.PI * 2;
const arc = (cx, cy, rx, ry, a0, a1) => {
  const n = Math.max(6, Math.ceil((Math.abs(a1 - a0) / TAU) * 36));
  const p = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    p.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
  }
  return p;
};
const ring = (cx, cy, rx, ry = rx) => arc(cx, cy, rx, ry, -Math.PI / 2, Math.PI * 1.5);
const loop = (...xy) => [...xy, xy[0], xy[1]];
const line = (...xy) => xy;
const dot = (x, y) => [x, y];
const wave = (x0, x1, y, amp, period) => {
  const p = [];
  for (let x = x0; x <= x1; x += 1.5) p.push(x, y + amp * Math.sin(((x - x0) / period) * TAU));
  return p;
};

/** Слова раунда 10. Ячейку 8 («Скорлупка») игрок пропустил: на ней в опросе показан ответ «Не помню». */
const DOODLES = {
  1: [ring(46, 54, 24, 14), loop(69, 54, 84, 42, 82, 66), dot(34, 50), arc(38, 54, 6, 10, -0.45 * Math.PI, 0.45 * Math.PI), ring(78, 30, 3), ring(72, 22, 2)],
  2: [loop(20, 76, 22, 56, 34, 40, 50, 32, 66, 38, 78, 48, 82, 64, 78, 76), line(46, 40, 50, 52, 44, 62), line(64, 50, 70, 60), line(12, 80, 88, 80)],
  3: [ring(50, 54, 28), line(40, 44, 40, 50), line(60, 44, 60, 50), arc(50, 56, 16, 13, 0.12 * Math.PI, 0.88 * Math.PI)],
  4: [ring(50, 50, 11, 10), ring(50, 69, 15, 13), line(48, 40, 48, 22), line(52, 40, 52, 22), ring(50, 19, 3), line(44, 64, 56, 64), line(74, 28, 30, 86)],
  5: [line(10, 32, 90, 30), loop(42, 24, 49, 24, 49, 78, 44, 78), loop(51, 24, 58, 24, 56, 78, 51, 78), ring(50, 50, 6)],
  6: [loop(24, 46, 60, 46, 60, 80, 24, 80), loop(24, 46, 38, 32, 74, 32, 60, 46), line(60, 80, 74, 66, 74, 32), line(42, 46, 56, 32)],
  7: [line(38, 32, 42, 74), line(62, 32, 58, 74), arc(50, 74, 8, 3, 0, Math.PI), ring(50, 32, 12, 4), dot(46, 46), dot(54, 54), dot(48, 62), dot(55, 41), dot(44, 56)],
  9: [loop(18, 50, 82, 50, 72, 66, 28, 66), line(24, 57, 77, 57), line(34, 52, 20, 76), line(66, 52, 80, 76), wave(12, 88, 76, 2.5, 12)],
  10: [loop(37, 26, 63, 26, 63, 33, 37, 33), loop(37, 33, 63, 33, 78, 78, 22, 78), line(44, 33, 38, 78), line(50, 33, 50, 78), line(56, 33, 62, 78)],
  11: [...[22, 37, 52, 67].map((x) => loop(x, 80, x, 34, x + 6, 26, x + 12, 34, x + 12, 80)), line(16, 46, 86, 46), line(16, 66, 86, 66)],
  12: [line(28, 84, 58, 30), line(33, 86, 63, 32), line(28, 84, 33, 86), loop(55, 34, 66, 16, 86, 28, 70, 46)],
  13: [loop(22, 40, 66, 40, 66, 74, 22, 74), ring(44, 57, 11), line(44, 46, 44, 68), line(33, 57, 55, 57), line(66, 48, 80, 48, 80, 30), ring(82, 23, 3), ring(88, 15, 2), line(26, 74, 26, 80), line(62, 74, 62, 80)],
  14: [line(24, 80, 76, 66), line(24, 66, 76, 80), loop(50, 22, 60, 36, 66, 50, 60, 64, 40, 64, 34, 50, 40, 38, 46, 44), loop(50, 40, 55, 50, 53, 60, 47, 60, 45, 50)],
  15: [loop(16, 78, 50, 30, 84, 78), line(42, 78, 50, 54, 58, 78), line(50, 30, 50, 18), loop(50, 18, 62, 21, 50, 24)],
  16: [loop(14, 44, 22, 52, 78, 52, 86, 44, 82, 50, 78, 57, 22, 57, 18, 50), ring(32, 64, 5), ring(68, 64, 5)],
  17: [line(18, 70, 78, 34), line(22, 76, 82, 40), line(18, 70, 22, 76), line(78, 34, 82, 40), dot(41, 60), dot(49, 56), dot(57, 51), dot(64, 46), ring(70, 72, 3.5), line(73.5, 72, 73.5, 58, 79, 62)],
  18: [loop(34, 42, 64, 42, 66, 78, 32, 78), arc(64, 58, 12, 14, -0.5 * Math.PI, 0.5 * Math.PI), line(34, 62, 16, 42), loop(12, 44, 16, 38, 22, 42), dot(10, 52), dot(15, 56), dot(8, 60), line(40, 42, 40, 36, 58, 36, 58, 42)],
  19: [line(20, 32, 80, 32), line(20, 42, 80, 42), line(26, 32, 26, 56), line(74, 32, 74, 56), loop(16, 56, 84, 56, 84, 62, 16, 62), line(24, 62, 22, 80), line(76, 62, 78, 80)],
  20: [loop(24, 40, 70, 40, 70, 70, 24, 70), loop(70, 49, 77, 49, 77, 61, 70, 61), line(33, 55, 43, 55), line(38, 50, 38, 60), line(54, 55, 62, 55), line(48, 40, 48, 70)],
  21: [ring(50, 70, 14), ring(50, 46, 10), ring(50, 28, 7), dot(47, 26), dot(53, 26), line(50, 29, 58, 31), dot(50, 43), dot(50, 50), line(40, 46, 28, 36), line(60, 46, 72, 36)],
  22: [loop(14, 38, 56, 38, 56, 68, 14, 68), loop(56, 48, 72, 48, 82, 58, 82, 68, 56, 68), loop(60, 52, 70, 52, 76, 58, 60, 58), ring(28, 70, 6), ring(70, 70, 6)],
  23: [line(34, 86, 44, 48), line(66, 86, 56, 48), line(50, 82, 50, 74), line(50, 66, 50, 58), loop(24, 28, 76, 28, 76, 46, 24, 46), line(24, 37, 76, 37), line(41, 28, 41, 37), line(58, 28, 58, 37), line(33, 37, 33, 46), line(50, 37, 50, 46), line(67, 37, 67, 46)],
  24: [
    ...[0, 1, 2, 3, 4, 5, 6].map((k) => ring(50 + 24 * Math.cos(Math.PI + (k * Math.PI) / 6), 58 + 24 * Math.sin(Math.PI + (k * Math.PI) / 6), 7)),
    ring(27, 72, 6),
    ring(73, 72, 6),
    ring(50, 62, 12, 15),
    dot(46, 60),
    dot(54, 60),
    arc(50, 66, 5, 3, 0.1 * Math.PI, 0.9 * Math.PI),
  ],
  25: [loop(16, 74, 24, 62, 38, 62, 44, 74), loop(56, 74, 62, 62, 76, 62, 84, 74), line(50, 72, 49, 58, 46, 46, 40, 38, 34, 40), line(50, 72, 51, 58, 54, 46, 60, 38, 66, 40), line(50, 72, 50, 52, 50, 32), dot(32, 46), dot(68, 46), dot(50, 26), wave(14, 86, 82, 2, 10)],
};
/** Лишняя линия, которую убирает «Отменить». */
const STRAY = [line(58, 26, 72, 34, 60, 42, 76, 52, 64, 60, 80, 70)];

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Точки через каждые step единиц: так углы остаются углами, а скорость пальца — ровной. */
function densify(pts, step) {
  if (pts.length <= 2) return pts.slice();
  const out = [pts[0], pts[1]];
  for (let i = 2; i < pts.length; i += 2) {
    const [x0, y0, x1, y1] = [pts[i - 2], pts[i - 1], pts[i], pts[i + 1]];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let k = 1; k <= n; k++) out.push(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n);
  }
  return out;
}

/** Рука не идеальна: каждая линия чуть сдвинута, точки чуть дрожат. */
function sketch(strokes, seed) {
  const r = rng(seed);
  return strokes.map((pts) => {
    const dx = (r() - 0.5) * 2.4;
    const dy = (r() - 0.5) * 2.4;
    const out = pts.map((v, i) => v + (i % 2 ? dy : dx) + (r() - 0.5) * 0.6);
    return densify(out, 2).map((v) => Math.round(Math.min(100, Math.max(0, v)) * 100) / 100);
  });
}

// ——— Браузер ———

const SEED = {
  score: 23,
  rounds: Object.fromEntries(Array.from({ length: ROUND - 1 }, (_, i) => [i + 1, { best: 3, bestCorrect: 6, plays: 1 }])),
  tutorialSeen: true,
};

/** Кружок-«палец»: виден, пока его показывают, при нажатии сжимается и пускает круг. */
function fingerOverlay() {
  addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = `
      #tut-finger { position: fixed; left: -100px; top: -100px; width: 40px; height: 40px; margin: -20px 0 0 -20px;
        border-radius: 50%; background: rgba(255, 255, 255, 0.5); border: 3px solid rgba(42, 31, 61, 0.72);
        box-shadow: 0 3px 10px rgba(0, 0, 0, 0.28); pointer-events: none; z-index: 2147483647; opacity: 0;
        transition: opacity 0.25s, transform 0.1s, background 0.1s; }
      #tut-finger.on { opacity: 1; }
      #tut-finger.down { transform: scale(0.8); background: rgba(255, 255, 255, 0.85); }
      .tut-ripple { position: fixed; width: 40px; height: 40px; margin: -20px 0 0 -20px; border-radius: 50%;
        border: 3px solid rgba(255, 255, 255, 0.95); box-shadow: 0 0 0 2px rgba(42, 31, 61, 0.35);
        pointer-events: none; z-index: 2147483646; animation: tut-ripple 0.5s ease-out forwards; }
      @keyframes tut-ripple { from { transform: scale(0.7); opacity: 1; } to { transform: scale(2); opacity: 0; } }`;
    document.head.append(style);
    const finger = document.createElement('div');
    finger.id = 'tut-finger';
    document.body.append(finger);
    const place = (e) => {
      finger.style.left = `${e.clientX}px`;
      finger.style.top = `${e.clientY}px`;
    };
    addEventListener('pointermove', place, true);
    addEventListener(
      'pointerdown',
      (e) => {
        place(e);
        finger.classList.add('down');
        if (!finger.classList.contains('on')) return;
        const ripple = document.createElement('div');
        ripple.className = 'tut-ripple';
        ripple.style.left = `${e.clientX}px`;
        ripple.style.top = `${e.clientY}px`;
        document.body.append(ripple);
        setTimeout(() => ripple.remove(), 600);
      },
      true,
    );
    addEventListener('pointerup', () => finger.classList.remove('down'), true);
    window.__finger = {
      show: () => finger.classList.add('on'),
      hide: () => finger.classList.remove('on'),
    };
  });
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const context = await browser.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, locale: 'ru-RU' });
await context.addInitScript((seed) => localStorage.setItem('sclerotic-artist:progress', JSON.stringify(seed)), SEED);
await context.addInitScript(fingerOverlay);
const page = await context.newPage();
page.on('pageerror', (e) => console.log('  ошибка на странице:', e.message));
page.on('console', (m) => m.type() === 'error' && console.log('  консоль:', m.text()));

const now = () => Date.now() / 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = [];
const segments = [];
let segment = null;

function begin(name) {
  segment = { name, start: now() };
}

function end(at = now()) {
  segments.push({ ...segment, end: at });
  segment = null;
}

/** Реплика диктора; промис ждёт её конца и небольшой паузы. */
function say(id, gap = 0.25) {
  events.push({ type: 'line', id, t: now() });
  return sleep((LINES[`ui-${id}`] + gap) * 1000);
}

// ——— Палец ———

let pos = { x: 210, y: 470 };

async function glide(x, y, ms = 420) {
  const from = { ...pos };
  const n = Math.max(1, Math.round(ms / 16));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    await sleep(16);
  }
  pos = { x, y };
}

async function tap({ x, y }) {
  await glide(x, y);
  await sleep(150);
  await page.mouse.down();
  await sleep(110);
  await page.mouse.up();
  await sleep(120);
}

async function center(selector) {
  const box = await page.locator(selector).first().boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const finger = (on) => page.evaluate((on) => (on ? window.__finger.show() : window.__finger.hide()), on);

// ——— Поле ———

async function camera() {
  return page.evaluate(() => {
    const b = window.__round.board;
    const r = b.canvas.getBoundingClientRect();
    return { left: r.left, top: r.top, ...b.cam };
  });
}

function toScreen(cam, cell, u, v) {
  const i = cell - 1;
  const ox = PAD + (i % GRID) * (CELL + GAP);
  const oy = PAD + Math.floor(i / GRID) * (CELL + GAP);
  return { x: cam.left + cam.sx + (ox + u - cam.x) * cam.z, y: cam.top + cam.sy + (oy + v - cam.y) * cam.z };
}

async function cellCenter(cell) {
  return toScreen(await camera(), cell, 50, 50);
}

/** Рисует пальцем по-настоящему: те же события, что от касания. Скорость — в пикселях экрана за секунду. */
async function drawLive(cell, strokes, speed = 300) {
  const cam = await camera();
  for (const pts of strokes) {
    const screen = [];
    for (let k = 0; k < pts.length; k += 2) screen.push(toScreen(cam, cell, pts[k], pts[k + 1]));
    await glide(screen[0].x, screen[0].y, 200);
    await page.mouse.down();
    let { x, y } = screen[0];
    for (const p of screen.slice(1)) {
      const n = Math.max(1, Math.round(Math.hypot(p.x - x, p.y - y) / (speed * 0.016)));
      for (let k = 1; k <= n; k++) {
        await page.mouse.move(x + ((p.x - x) * k) / n, y + ((p.y - y) * k) / n);
        await sleep(16);
      }
      ({ x, y } = p);
    }
    await page.mouse.up();
    pos = { x, y };
    await sleep(60);
  }
}

/** Рисунки, сделанные «раньше»: сразу в поле, без пальца. */
async function prefill(cells) {
  const list = cells.map((cell) => [cell, sketch(DOODLES[cell], cell * 7919)]);
  await page.evaluate((list) => {
    const b = window.__round.board;
    for (const [cell, strokes] of list) b.strokes[cell - 1].push(...strokes.map((pts) => ({ width: 2.8, pts })));
    b.dirty = true;
    b.onChange();
  }, list);
}

// ——— Диктовка ———

/** Ставит диктовку на нужное место (мс от начала дорожки) и возвращает момент, когда это случилось. */
async function setDictation(ms) {
  const at = await page.evaluate((ms) => {
    const r = window.__round;
    const shift = performance.now() / 1000 - ms / 1000 - r.dictationStart;
    r.dictationStart += shift;
    r.dictationEnd += shift;
    return Date.now() / 1000;
  }, ms);
  return at;
}

/** Держит диктовку на месте: подсветка не уходит дальше, пока диктор объясняет. */
async function freeze(ms) {
  await page.evaluate((ms) => {
    clearInterval(window.__freeze);
    const r = window.__round;
    const hold = () => {
      const shift = performance.now() / 1000 - ms / 1000 - r.dictationStart;
      r.dictationStart += shift;
      r.dictationEnd += shift;
    };
    hold();
    window.__freeze = setInterval(hold, 20);
  }, ms);
}

const unfreeze = () => page.evaluate(() => clearInterval(window.__freeze));

/** Слышно, как голос раунда читает дорожку с offset мс в течение duration мс. */
async function hear(offsetMs, durationMs) {
  const at = await setDictation(offsetMs);
  events.push({ type: 'dictation', t: at, offset: offsetMs / 1000, duration: durationMs / 1000 });
}

/** Перематывает диктовку к номеру ячейки и даёт его услышать. */
async function hearNumber(cell) {
  const c = TIMING[cell - 1];
  await hear(c.number_start_ms - 250, c.number_ms + 550);
  return c;
}

const questionShows = (n) =>
  page.waitForFunction(
    (n) => !document.querySelector('.quiz-panel')?.hidden && document.querySelector('.quiz-question')?.textContent.includes(`№${n}?`),
    n,
    { polling: 20, timeout: 60000 },
  );

/**
 * Опрос берёт ячейки через Math.random. Подменяем его на один перемешивающий проход:
 * первыми спросят №3 (её рисовали в ролике) и №8 (пустую).
 */
const steerQuiz = () =>
  page.evaluate(() => {
    const original = Math.random;
    let call = 0;
    Math.random = () => {
      const i = 24 - call++;
      if (call >= 24) Math.random = original;
      return i === 7 ? 0.15 : i === 2 ? 0.1 : 0.99999;
    };
  });

// ——— Съёмка ———

console.log('Открываю игру…');
await page.goto(APP_URL);
await page.getByRole('button', { name: 'Запустить' }).click();
await page.waitForSelector('video.intro-video');
await page.evaluate(async () => {
  const v = document.querySelector('video.intro-video');
  if (v.readyState < 1) await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
  v.currentTime = Math.max(0, v.duration - 0.1);
});
await page.click('.sound-warning', { timeout: 30000 });
await page.click('.next-card .btn');
await page.waitForSelector('.ready');
for (let i = 0; i < 2; i++) {
  await sleep(350);
  await page.click('.ready');
}
await page.waitForFunction(() => window.__round?.phase === 'draw', null, { timeout: 30000 });
await freeze(TIMING[1].number_start_ms + 3000);
await prefill([1, 2]);
await sleep(600);
await page.screenshot({ path: PHONE_REF });

const cdp = await context.newCDPSession(page);
const frames = [];
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  const file = `${String(frames.length).padStart(5, '0')}.jpg`;
  frames.push({ file, t: metadata.timestamp });
  writeFileSync(join(FRAMES, file), Buffer.from(data, 'base64'));
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 720, maxHeight: 1280, everyNthFrame: 1 });
await sleep(800);

console.log('Диктовка и рисование…');
await page.mouse.move(pos.x, pos.y);
begin('draw');
await sleep(300);
await say('board');
await say('number', 0.1);
await unfreeze();
const three = TIMING[2];
await hear(three.number_start_ms - 250, three.word_start_ms + three.word_ms + 350 - (three.number_start_ms - 250));
await sleep(three.word_start_ms + three.word_ms - three.number_start_ms + 450);
// Пока №3 рисуют, голос стоит на ней: иначе подсветка уйдёт дальше раньше, чем о ней скажут.
await freeze(three.word_start_ms + three.word_ms + 600);
await say('word');

await finger(true);
let speech = say('zoom');
await sleep(700);
await tap(await cellCenter(3));
await speech;
speech = say('draw');
await sleep(150);
await drawLive(3, sketch(DOODLES[3], 3));
await speech;
await sleep(200);

speech = say('oops');
await drawLive(3, sketch(STRAY, 11), 420);
await speech;
speech = say('undo');
await sleep(150);
await tap(await center('.hud-bottom .tool:nth-child(1)'));
await speech;

// Голос перешёл к №4 — и стрелка ведёт туда же.
await unfreeze();
await setDictation(TIMING[3].number_start_ms - 300);
speech = say('next');
await sleep(250);
await tap(await center('.hud-bottom .tool:nth-child(4)'));
await speech;
speech = say('zoomout');
await sleep(200);
await tap(await center('.hud-bottom .tool:nth-child(2)'));
await speech;

// Игрок задержался, а голос уже на №6: кнопка с динамиком ведёт к №5, о которой он договорил.
const called = await hearNumber(6);
await sleep(called.number_ms + 450);
speech = say('speaker');
await sleep(2300);
await tap(await center('.hud-bottom .tool:nth-child(3)'));
await speech;
await sleep(500);
await finger(false);
end();

console.log('Последние 30 секунд…');
await prefill([4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
await page.evaluate(() => window.__round.board.focus(null, false));
await page.evaluate(() => window.__round.skip());
await sleep(400);
begin('final');
await sleep(300);
await say('final');
await steerQuiz();
await page.mouse.move(250, 300);
pos = { x: 250, y: 300 };
await finger(true);
speech = say('done');
await sleep(1200);
await tap(await center('.hud-top .btn-green'));
await finger(false);
await speech;
await sleep(500);
end();

console.log('Опрос…');
await questionShows(3);
const asked = now();
begin('quiz');
segment.start = asked - 0.05;
events.push({ type: 'game', file: 'numbers/03.wav', t: asked });
await page.mouse.move(180, 560);
pos = { x: 180, y: 560 };
await sleep(900);
await finger(true);
speech = say('quiz');
await sleep(2200);
await tap(await center('.quiz-input'));
await page.keyboard.type('улыбка', { delay: 120 });
await sleep(250);
await tap(await center('.quiz-form .btn'));
events.push({ type: 'sfx', kind: 'correct', t: now() });
await speech;
const praised = now();
await say('right', 0.1);
await questionShows(8);
// Номер звучит, когда диктор договорил: так голоса не перекрывают друг друга.
events.push({ type: 'game', file: 'numbers/08.wav', t: Math.max(now(), praised + LINES['ui-right'] + 0.1) });
await sleep(1100);
speech = say('wrong');
await sleep(800);
await tap(await center('.link-btn'));
const dunno = now();
events.push({ type: 'sfx', kind: 'wrong', t: dunno });
// На месте «Не помню» появится правильный ответ: палец его не закрывает.
await finger(false);
await speech;
end(Math.min(now() + 0.4, dunno + 2.5));
await sleep(600);

await cdp.send('Page.stopScreencast');
await browser.close();
writeFileSync(join(OUT, 'timeline.json'), JSON.stringify({ frames, segments, events }, null, 1));
const fps = frames.length / (frames.at(-1).t - frames[0].t);
console.log(`Кадров ${frames.length} (≈${fps.toFixed(0)} в секунду), отрезков ${segments.length}, событий ${events.length}`);
