/** Линия маркера; точки в координатах ячейки (0…CELL), парами x, y. */
export interface Stroke {
  width: number;
  pts: number[];
}

export const GRID = 5;
export const CELLS = GRID * GRID;

// Мир измеряется в условных единицах: ячейка 100×100.
const CELL = 100;
const GAP = 12;
const PAD = 16;
const BOARD = PAD * 2 + GRID * CELL + (GRID - 1) * GAP;
const RADIUS = 5;

const MARKER_WIDTH = 2.8;
const MIN_STEP = 0.35;
const TAP_PX = 10;
/** Какую долю короткой стороны экрана занимает ячейка при приближении: остальное — соседи. */
const FOCUS_SHARE = 0.68;
const ANIM_MS = 280;
const MAX_DPR = 2;

const COLORS = {
  desk: '#efe4cf',
  board: '#e2d0ae',
  paper: '#fffdf8',
  shadow: 'rgba(96, 66, 24, 0.2)',
  number: '#a8987f',
  numberFocused: '#6a2ea8',
  ink: 'rgba(22, 20, 28, 0.93)',
  highlight: '246, 172, 30',
};

/** Камера: какая точка мира (x, y) стоит в точке экрана (sx, sy) и с каким увеличением z. */
interface Camera {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
}

interface Pen {
  id: number;
  rect: DOMRect;
  startX: number;
  startY: number;
  travel: number;
  /** По какой ячейке нажали — для перехода касанием. */
  hit: number | null;
  /** В какую ячейку идёт линия, если рисуем. */
  cell: number;
  stroke: Stroke | null;
}

function origin(cell: number) {
  return { x: PAD + (cell % GRID) * (CELL + GAP), y: PAD + Math.floor(cell / GRID) * (CELL + GAP) };
}

export function drawStroke(c: CanvasRenderingContext2D, stroke: Stroke) {
  const p = stroke.pts;
  if (p.length === 2) {
    c.beginPath();
    c.arc(p[0], p[1], stroke.width / 2, 0, Math.PI * 2);
    c.fill();
    return;
  }
  c.lineWidth = stroke.width;
  c.beginPath();
  c.moveTo(p[0], p[1]);
  // Сглаживание: кривые через середины отрезков.
  for (let i = 2; i < p.length - 2; i += 2) {
    c.quadraticCurveTo(p[i], p[i + 1], (p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2);
  }
  c.lineTo(p[p.length - 2], p[p.length - 1]);
  c.stroke();
}

function setInk(c: CanvasRenderingContext2D) {
  c.strokeStyle = c.fillStyle = COLORS.ink;
  c.lineCap = 'round';
  c.lineJoin = 'round';
}

function clipToCell(c: CanvasRenderingContext2D) {
  c.beginPath();
  c.roundRect(0, 0, CELL, CELL, RADIUS);
  c.clip();
}

/** Рисует лист с номером и рисунком; контекст уже смещён в левый верхний угол ячейки. */
function drawCell(c: CanvasRenderingContext2D, number: number, strokes: Stroke[], focused: boolean) {
  c.fillStyle = COLORS.shadow;
  c.beginPath();
  c.roundRect(1.5, 2.5, CELL, CELL, RADIUS);
  c.fill();
  c.fillStyle = COLORS.paper;
  c.beginPath();
  c.roundRect(0, 0, CELL, CELL, RADIUS);
  c.fill();
  c.fillStyle = focused ? COLORS.numberFocused : COLORS.number;
  c.font = '700 17px Caveat, cursive';
  c.textBaseline = 'top';
  c.fillText(String(number), 6, 4);
  c.save();
  clipToCell(c);
  setInk(c);
  for (const s of strokes) drawStroke(c, s);
  c.restore();
}

/** Отдельная картинка ячейки — для итогов раунда. */
export function renderThumb(strokes: Stroke[], number: number, size = 200): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const c = canvas.getContext('2d')!;
  const k = size / CELL;
  c.setTransform(k, 0, 0, k, 0, 0);
  c.fillStyle = COLORS.paper;
  c.fillRect(0, 0, CELL, CELL);
  c.fillStyle = COLORS.number;
  c.font = '700 17px Caveat, cursive';
  c.textBaseline = 'top';
  c.fillText(String(number), 6, 4);
  setInk(c);
  for (const s of strokes) drawStroke(c, s);
  return canvas;
}

/**
 * Поле 5×5 на одном холсте: камера, рисование маркером и переходы между ячейками.
 * Рисунки хранятся как линии, поэтому при любом приближении остаются чёткими.
 */
export class Board {
  readonly strokes: Stroke[][] = Array.from({ length: CELLS }, () => []);
  /** Ячейка, которую сейчас диктуют: подсвечивается. */
  highlight: number | null = null;
  /** Фокус или рисунок изменились. */
  onChange = () => {};

  private readonly ctx: CanvasRenderingContext2D;
  // Неподвижная часть сцены рисуется в отдельный слой и копируется каждый кадр.
  private readonly layer = document.createElement('canvas');
  private readonly layerCtx: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver;
  private w = 1;
  private h = 1;
  private dpr = 1;
  private insets = { top: 0, bottom: 0 };
  private focusedCell: number | null = null;
  private drawing = false;
  private cam: Camera = { x: BOARD / 2, y: BOARD / 2, z: 1, sx: 0, sy: 0 };
  private anim: { from: Camera; to: Camera; start: number } | null = null;
  private dirty = true;
  private pen: Pen | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.layerCtx = this.layer.getContext('2d')!;
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
  }

  get focused() {
    return this.focusedCell;
  }

  /** Можно ли рисовать и переходить между ячейками. */
  get interactive() {
    return this.drawing;
  }

  set interactive(value: boolean) {
    this.drawing = value;
    if (!value && this.pen) this.finishPen(false);
    this.updateCursor();
  }

  /** Приближает камеру к ячейке; null — показать всё поле. */
  focus(cell: number | null, animate = true) {
    this.focusedCell = cell;
    this.moveCamera(animate);
    this.updateCursor();
    this.onChange();
  }

  step(dx: number, dy: number) {
    if (this.focusedCell === null) {
      this.focus(this.highlight ?? 0);
      return;
    }
    const col = Math.min(GRID - 1, Math.max(0, (this.focusedCell % GRID) + dx));
    const row = Math.min(GRID - 1, Math.max(0, Math.floor(this.focusedCell / GRID) + dy));
    this.focus(row * GRID + col);
  }

  canUndo() {
    return this.focusedCell !== null && this.strokes[this.focusedCell].length > 0;
  }

  undo() {
    if (!this.canUndo()) return;
    this.strokes[this.focusedCell!].pop();
    this.dirty = true;
    this.onChange();
  }

  /** Место, занятое панелями сверху и снизу: камера центрирует поле в оставшейся части. */
  setInsets(top: number, bottom: number) {
    if (top === this.insets.top && bottom === this.insets.bottom) return;
    this.insets = { top, bottom };
    this.moveCamera(true);
  }

  render(now: number) {
    if (this.anim) {
      const t = Math.min(1, (now - this.anim.start) / ANIM_MS);
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      const { from, to } = this.anim;
      const mix = (a: number, b: number) => a + (b - a) * e;
      this.cam = {
        x: mix(from.x, to.x),
        y: mix(from.y, to.y),
        z: from.z * (to.z / from.z) ** e,
        sx: mix(from.sx, to.sx),
        sy: mix(from.sy, to.sy),
      };
      if (t >= 1) this.anim = null;
      this.dirty = true;
    }
    if (this.dirty) {
      this.drawScene(this.layerCtx);
      this.dirty = false;
    }
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(this.layer, 0, 0);
    this.applyCamera(c);
    if (this.highlight !== null) this.drawHighlight(c, this.highlight, now);
    if (this.pen?.stroke) {
      const o = origin(this.pen.cell);
      c.save();
      c.translate(o.x, o.y);
      clipToCell(c);
      setInk(c);
      drawStroke(c, this.pen.stroke);
      c.restore();
    }
  }

  destroy() {
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onUp);
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, rect.width);
    this.h = Math.max(1, rect.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    for (const canvas of [this.canvas, this.layer]) {
      canvas.width = Math.round(this.w * this.dpr);
      canvas.height = Math.round(this.h * this.dpr);
    }
    this.moveCamera(false);
  }

  private target(): Camera {
    const availW = this.w;
    const availH = Math.max(1, this.h - this.insets.top - this.insets.bottom);
    const screen = { sx: this.w / 2, sy: this.insets.top + availH / 2 };
    if (this.focusedCell === null) {
      return { x: BOARD / 2, y: BOARD / 2, z: Math.min(availW, availH) / BOARD, ...screen };
    }
    const o = origin(this.focusedCell);
    return { x: o.x + CELL / 2, y: o.y + CELL / 2, z: (Math.min(availW, availH) * FOCUS_SHARE) / CELL, ...screen };
  }

  private moveCamera(animate: boolean) {
    const to = this.target();
    this.anim = animate ? { from: { ...this.cam }, to, start: performance.now() } : null;
    if (!animate) this.cam = to;
    this.dirty = true;
  }

  private applyCamera(c: CanvasRenderingContext2D) {
    const { x, y, z, sx, sy } = this.cam;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.translate(sx, sy);
    c.scale(z, z);
    c.translate(-x, -y);
  }

  private drawScene(c: CanvasRenderingContext2D) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = COLORS.desk;
    c.fillRect(0, 0, this.layer.width, this.layer.height);
    this.applyCamera(c);
    c.fillStyle = COLORS.board;
    c.beginPath();
    c.roundRect(0, 0, BOARD, BOARD, 14);
    c.fill();

    const { x, y, z, sx, sy } = this.cam;
    const view = { left: x - sx / z, top: y - sy / z, right: x + (this.w - sx) / z, bottom: y + (this.h - sy) / z };
    for (let i = 0; i < CELLS; i++) {
      const o = origin(i);
      if (o.x > view.right || o.x + CELL < view.left || o.y > view.bottom || o.y + CELL < view.top) continue;
      c.save();
      c.translate(o.x, o.y);
      // При приближении соседние ячейки приглушены, чтобы было видно, где рисуешь.
      c.globalAlpha = this.focusedCell === null || this.focusedCell === i ? 1 : 0.5;
      drawCell(c, i + 1, this.strokes[i], this.focusedCell === i);
      c.restore();
    }
  }

  private drawHighlight(c: CanvasRenderingContext2D, cell: number, now: number) {
    const o = origin(cell);
    const pulse = 0.5 + 0.5 * Math.sin(now / 170);
    const width = (3 + 2.5 * pulse) / this.cam.z;
    const out = width / 2 + 1.5 / this.cam.z;
    c.strokeStyle = `rgba(${COLORS.highlight}, ${0.55 + 0.45 * pulse})`;
    c.lineWidth = width;
    c.beginPath();
    c.roundRect(o.x - out, o.y - out, CELL + out * 2, CELL + out * 2, RADIUS + out);
    c.stroke();
  }

  private updateCursor() {
    this.canvas.classList.toggle('drawing', this.drawing && this.focusedCell !== null);
  }

  private toWorld(e: PointerEvent, rect: DOMRect) {
    const { x, y, z, sx, sy } = this.cam;
    return { x: (e.clientX - rect.left - sx) / z + x, y: (e.clientY - rect.top - sy) / z + y };
  }

  private cellAt(p: { x: number; y: number }, pad = 0): number | null {
    for (let i = 0; i < CELLS; i++) {
      const o = origin(i);
      if (p.x >= o.x - pad && p.x <= o.x + CELL + pad && p.y >= o.y - pad && p.y <= o.y + CELL + pad) return i;
    }
    return null;
  }

  private onDown = (e: PointerEvent) => {
    if (!this.drawing || this.pen || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    // Быстрый игрок не ждёт конца полёта камеры.
    if (this.anim) {
      this.cam = this.anim.to;
      this.anim = null;
      this.dirty = true;
    }
    const rect = this.canvas.getBoundingClientRect();
    const p = this.toWorld(e, rect);
    const cell = this.focusedCell;
    // Линию можно начать и в щели у края листа: так проще рисовать до самой границы.
    const drawing = cell !== null && this.cellAt(p, GAP / 2) === cell;
    this.pen = {
      id: e.pointerId,
      rect,
      startX: e.clientX,
      startY: e.clientY,
      travel: 0,
      hit: this.cellAt(p),
      cell: cell ?? 0,
      stroke: drawing ? { width: MARKER_WIDTH, pts: [] } : null,
    };
    if (drawing) {
      const o = origin(cell);
      const clamp = (v: number) => Math.min(CELL, Math.max(0, v));
      this.pen.stroke!.pts.push(round(clamp(p.x - o.x)), round(clamp(p.y - o.y)));
    }
  };

  private onMove = (e: PointerEvent) => {
    const pen = this.pen;
    if (!pen || e.pointerId !== pen.id) return;
    pen.travel = Math.max(pen.travel, Math.hypot(e.clientX - pen.startX, e.clientY - pen.startY));
    if (!pen.stroke) return;
    const events = e.getCoalescedEvents?.() ?? [];
    for (const ev of events.length ? events : [e]) this.addPoint(pen, this.toWorld(ev, pen.rect));
  };

  private onUp = (e: PointerEvent) => {
    const pen = this.pen;
    if (!pen || e.pointerId !== pen.id) return;
    if (pen.stroke && e.type === 'pointerup') this.addPoint(pen, this.toWorld(e, pen.rect));
    this.finishPen(e.type === 'pointerup');
  };

  private finishPen(tapAllowed: boolean) {
    const pen = this.pen!;
    this.pen = null;
    if (pen.stroke) {
      this.strokes[pen.cell].push(pen.stroke);
      this.dirty = true;
      this.onChange();
    } else if (tapAllowed && pen.travel < TAP_PX && pen.hit !== null) {
      this.focus(pen.hit);
    }
  }

  private addPoint(pen: Pen, p: { x: number; y: number }) {
    const pts = pen.stroke!.pts;
    const o = origin(pen.cell);
    const x = p.x - o.x;
    const y = p.y - o.y;
    if (Math.hypot(x - pts[pts.length - 2], y - pts[pts.length - 1]) < MIN_STEP) return;
    pts.push(round(x), round(y));
  }
}

const round = (v: number) => Math.round(v * 100) / 100;
