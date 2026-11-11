import { isCorrect } from './answer';
import { audio, type Voice } from './audio';
import { Board, CELLS, GRID, renderThumb } from './board';
import { QUIZ_SIZE, type RoundInfo } from './content';
import { progress } from './progress';
import { h, icon, points, setScreen, signed } from './ui';

const FINAL_SECONDS = 30;
const URGENT_SECONDS = 5;
/** На сколько секунд голос может разойтись с часами раунда, прежде чем его перезапустят с нужного места. */
const MAX_DRIFT = 0.25;

const wallNow = () => performance.now() / 1000;

/** Куда идти после раунда: в меню или сразу в раунд с этим номером. */
export type RoundExit = 'menu' | number;

type Phase = 'ready' | 'draw' | 'final' | 'quiz' | 'results';

interface RoundSound {
  dictation: AudioBuffer;
  time30s: AudioBuffer;
  quizIntro: AudioBuffer;
  quizIntroEarly: AudioBuffer;
}

interface QuizAnswer {
  cell: number;
  word: string;
  answer: string | null;
  ok: boolean;
}

class Aborted extends Error {}

export function playRound(info: RoundInfo): Promise<RoundExit> {
  return new RoundSession(info).run();
}

function loadSound(info: RoundInfo): Promise<RoundSound> {
  return Promise.all([
    audio.load(info.dictationUrl),
    audio.load(info.time30sUrl),
    audio.load(info.quizIntroUrl),
    audio.load(info.quizIntroEarlyUrl),
  ]).then(([dictation, time30s, quizIntro, quizIntroEarly]) => ({ dictation, time30s, quizIntro, quizIntroEarly }));
}

function pickCells(count: number): number[] {
  const cells = Array.from({ length: CELLS }, (_, i) => i);
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  return cells.slice(0, count);
}

/**
 * Дорожка, привязанная к настоящему времени. Если звук стоял (приложение было свёрнуто),
 * она не продолжает с места остановки, а перескакивает туда, где должна быть сейчас.
 */
class Track {
  private voice: Voice | null = null;
  private ctxStart = 0;

  constructor(
    private readonly buffer: AudioBuffer,
    private readonly start: number,
    private readonly play: (buffer: AudioBuffer, offset: number) => Voice,
  ) {}

  sync(now: number) {
    if (audio.ctx.state !== 'running') return;
    const offset = now - this.start;
    if (offset >= this.buffer.duration) {
      this.stop();
      return;
    }
    if (this.voice && Math.abs(audio.ctx.currentTime - this.ctxStart - offset) < MAX_DRIFT) return;
    this.voice?.stop();
    this.voice = this.play(this.buffer, Math.max(0, offset));
    this.ctxStart = audio.ctx.currentTime - offset;
  }

  stop() {
    this.voice?.stop();
    this.voice = null;
  }
}

function toolButton(name: Parameters<typeof icon>[0], label: string, onclick: () => void) {
  return h('button', { class: 'tool', onclick }, icon(name), h('span', {}, label));
}

interface HudActions {
  menu(): void;
  done(): void;
  undo(): void;
  zoomOut(): void;
  spoken(): void;
  next(): void;
  repeat(): void;
}

type Hud = ReturnType<typeof buildHud>;

function buildHud(info: RoundInfo, act: HudActions) {
  const canvas = h('canvas', { class: 'board' });
  const caption = h('div', { class: 'hud-caption' }, `Раунд ${info.round}`);
  const status = h('div', { class: 'hud-status' }, 'Приготовьтесь');
  const done = h('button', { class: 'btn btn-green btn-small', hidden: true, onclick: act.done }, icon('check'), 'Готово');
  const bar = h('i');
  const progressBar = h('div', { class: 'hud-progress' }, bar);
  const menu = h('button', { class: 'icon-btn', 'aria-label': 'Пауза', onclick: act.menu }, icon('pause'));
  const soundHint = h('div', { class: 'sound-hint', hidden: true }, icon('speaker'), 'Коснитесь экрана, чтобы вернуть звук');
  const top = h('header', { class: 'hud-top' }, menu, h('div', { class: 'hud-center' }, caption, status), done, progressBar, soundHint);

  const undo = toolButton('undo', 'Отменить', act.undo);
  const zoom = toolButton('grid', 'Отдалить', act.zoomOut);
  const spoken = toolButton('speaker', '', act.spoken);
  spoken.title = 'К ячейке, о которой голос говорил последней';
  const next = toolButton('arrow', '', act.next);
  const tools = h('footer', { class: 'hud-bottom', hidden: true }, undo, zoom, spoken, next);

  const question = h('div', { class: 'quiz-question' });
  const input = h('input', {
    class: 'quiz-input',
    type: 'text',
    placeholder: 'Ваш ответ',
    autocomplete: 'off',
    autocapitalize: 'none',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'send',
    maxlength: 60,
  });
  // Форма никогда не отправляется по-настоящему: ответ принимает ask().
  const form = h(
    'form',
    { class: 'quiz-form', onsubmit: (e: Event) => e.preventDefault() },
    input,
    h('button', { class: 'btn', type: 'submit' }, 'Ответить'),
  );
  const dunno = h('button', { class: 'link-btn', type: 'button' }, 'Не помню');
  const feedback = h('div', { class: 'quiz-feedback', hidden: true });
  const quiz = h(
    'div',
    { class: 'quiz-panel', hidden: true },
    h(
      'div',
      { class: 'quiz-head' },
      question,
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Повторить номер', onclick: act.repeat }, icon('speaker')),
    ),
    form,
    dunno,
    feedback,
  );

  return { canvas, caption, status, done, bar, progressBar, menu, soundHint, top, undo, zoom, spoken, next, tools, quiz, question, input, form, dunno, feedback };
}

/**
 * Один раунд от экранов подготовки до итогов.
 * Рисование (диктовка и 30 секунд) идёт по настоящим часам, и остановить его нельзя.
 * Остальное считается по часам аудиоконтекста: на паузе контекст стоит, и задержки замирают вместе со звуком.
 */
class RoundSession {
  private readonly board: Board;
  private readonly root: HTMLElement;
  private readonly ui: Hud;
  private readonly voices = new Set<Voice>();
  private readonly timers = new Set<{ at: number; done: () => void }>();
  private readonly resizeObserver: ResizeObserver;
  private readonly cancelled: Promise<never>;
  private cancel: () => void = () => {};
  private phase: Phase = 'ready';
  private paused: HTMLElement | null = null;
  private exitDialog: HTMLElement | null = null;
  private raf = 0;
  private sound: RoundSound | null = null;
  private track: Track | null = null;
  private dictationStart = 0;
  private dictationEnd = 0;
  private finalEnd = 0;
  private shownSecond = -1;
  private highlight: number | null = null;
  /** Досрочно завершает текущую фазу: кнопка «Готово» и отладочный skip(). */
  private endPhase: (() => void) | null = null;
  private quizCell = 0;
  private numberVoice: Voice | null = null;

  constructor(private readonly info: RoundInfo) {
    this.cancelled = new Promise<never>((_, reject) => (this.cancel = () => reject(new Aborted())));
    this.cancelled.catch(() => {});
    this.ui = buildHud(info, {
      menu: () => (this.drawing ? this.confirmExit() : this.pause()),
      done: () => this.endPhase?.(),
      undo: () => this.board.undo(),
      zoomOut: () => this.board.focus(null),
      spoken: () => {
        const cell = this.spokenCell();
        if (cell !== null) this.board.focus(cell);
      },
      next: () => this.board.focus(this.nextCell()),
      repeat: () => this.sayNumber(this.quizCell),
    });
    this.board = new Board(this.ui.canvas);
    this.board.onChange = () => this.updateTools();
    const { canvas, top, tools, quiz } = this.ui;
    this.root = h('div', { class: 'screen round' }, canvas, top, tools, quiz);
    // Телефон может вернуть звук только по нажатию — во время рисования об этом просит подсказка soundHint.
    this.root.addEventListener(
      'pointerdown',
      () => {
        if (!this.pausable && audio.ctx.state !== 'running') void audio.resume();
      },
      true,
    );
    this.resizeObserver = new ResizeObserver(() => this.syncInsets());
    for (const el of [top, tools, quiz]) this.resizeObserver.observe(el);
  }

  async run(): Promise<RoundExit> {
    setScreen(this.root);
    // Из итогов можно сразу перейти в следующий раунд, а там музыка мешала бы слушать диктовку.
    audio.stopMusic();
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('keydown', this.onKey);
    this.raf = requestAnimationFrame(this.tick);
    if (import.meta.env.DEV) Object.assign(window, { __round: this });
    try {
      const sound = loadSound(this.info);
      sound.then((s) => (this.sound = s), () => {});
      await this.ready(sound);
      const s = await this.guard(sound);
      await this.dictate(s);
      const early = await this.finalSeconds(s);
      const answers = await this.quiz(s, early);
      return await this.results(answers);
    } catch (e) {
      if (e instanceof Aborted) return 'menu';
      console.error(e);
      return await this.failure();
    } finally {
      this.dispose();
    }
  }

  /** Для отладки из консоли: __round.skip() завершает диктовку или 30 секунд. */
  skip() {
    this.endPhase?.();
  }

  // ——— Фазы ———

  private async ready(sound: Promise<RoundSound>) {
    const card = h('div', { class: 'ready' });
    const show = (cls: string, ...children: (Node | string)[]) => {
      card.className = `ready ${cls}`;
      card.replaceChildren(...children);
    };
    this.root.append(card);

    show(
      '',
      h('div', { class: 'ready-kicker' }, 'Раунд'),
      h('div', { class: 'ready-number' }, String(this.info.round)),
      h('p', {}, `Диктует ${this.info.narrator}`),
    );
    await this.waitOrTap(2200, card);
    show(
      '',
      h('div', { class: 'ready-title' }, 'Приготовьтесь!'),
      h('p', {}, 'Голос назовёт номер ячейки, а через секунду — слово. Нарисуйте это слово в ячейке с таким номером.'),
    );
    await this.waitOrTap(3800, card);
    if (!this.sound) {
      show('', h('span', { class: 'spinner' }), h('p', {}, 'Загружаем голос…'));
      await this.guard(sound);
    }
    for (const n of ['3', '2', '1']) {
      show('count', h('div', { class: 'ready-number' }, n));
      audio.sfx('tick');
      await this.wait(750);
    }
    show('go', h('div', { class: 'ready-title' }, 'Рисуйте!'));
    audio.sfx('go');
    await this.wait(550);
    card.remove();
  }

  private async dictate(s: RoundSound) {
    this.phase = 'draw';
    this.updateMenuButton();
    this.board.interactive = true;
    this.ui.tools.hidden = false;
    this.updateTools();
    this.dictationStart = wallNow();
    this.dictationEnd = this.dictationStart + s.dictation.duration;
    this.track = new Track(s.dictation, this.dictationStart, (b, offset) => this.say(b, offset));
    await this.guard(new Promise<void>((resolve) => (this.endPhase = resolve)));
    this.endPhase = null;
    this.track.stop();
    this.setHighlight(null);
  }

  /** Возвращает true, если игрок нажал «Готово», не дожидаясь конца отсчёта. */
  private async finalSeconds(s: RoundSound): Promise<boolean> {
    this.phase = 'final';
    // Отсчёт идёт от конца диктовки, даже если игрок в этот момент был в другом приложении.
    const start = Math.min(wallNow(), this.dictationEnd);
    this.finalEnd = start + FINAL_SECONDS;
    this.track = new Track(s.time30s, start, (b, offset) => this.say(b, offset));
    this.ui.progressBar.classList.add('final');
    this.ui.done.hidden = false;
    this.updateTools();
    await this.guard(new Promise<void>((resolve) => (this.endPhase = resolve)));
    const early = wallNow() < this.finalEnd;
    this.endPhase = null;
    this.track.stop();
    this.track = null;
    this.closeExitDialog();
    this.ui.soundHint.hidden = true;
    this.board.interactive = false;
    this.ui.status.classList.remove('urgent');
    this.ui.done.hidden = true;
    this.ui.tools.hidden = true;
    this.ui.progressBar.classList.remove('final');
    return early;
  }

  private async quiz(s: RoundSound, early: boolean): Promise<QuizAnswer[]> {
    this.phase = 'quiz';
    this.updateMenuButton();
    audio.playMusic('quiet');
    this.board.focus(null);
    const title = early ? 'Рисунок готов' : 'Время вышло';
    this.ui.status.textContent = title;
    this.ui.bar.style.width = '0%';
    const banner = h(
      'div',
      { class: 'ready alert' },
      h('div', { class: 'ready-title' }, `${title}!`),
      h('p', {}, 'Сейчас прозвучат номера ячеек. Вспомните, что вы в них нарисовали.'),
    );
    this.root.append(banner);
    await this.guard(this.say(early ? s.quizIntroEarly : s.quizIntro).ended);
    banner.remove();

    const cells = pickCells(QUIZ_SIZE);
    const answers: QuizAnswer[] = [];
    let score = 0;
    this.ui.quiz.hidden = false;
    for (const [i, cell] of cells.entries()) {
      this.ui.caption.textContent = `Вопрос ${i + 1} из ${cells.length}`;
      this.ui.status.textContent = `Счёт: ${signed(score)}`;
      this.ui.bar.style.width = `${(i / cells.length) * 100}%`;
      this.quizCell = cell;
      this.board.focus(cell);
      const reply = this.ask(cell);
      this.sayNumber(cell);
      const answer = await this.guard(reply);
      const word = this.info.cells[cell].word;
      const ok = answer !== null && isCorrect(answer, word);
      score += ok ? 1 : -1;
      answers.push({ cell, word, answer, ok });
      audio.sfx(ok ? 'correct' : 'wrong');
      this.showFeedback(ok, word);
      this.ui.status.textContent = `Счёт: ${signed(score)}`;
      await this.waitOrTap(ok ? 1300 : 2600, this.ui.quiz);
    }
    this.ui.bar.style.width = '100%';
    return answers;
  }

  private results(answers: QuizAnswer[]): Promise<RoundExit> {
    this.phase = 'results';
    audio.playMusic();
    const correct = answers.filter((a) => a.ok).length;
    const score = correct - (answers.length - correct);
    progress.finishRound(this.info.round, score, correct);
    const next = progress.nextRound();
    this.ui.input.blur();

    return new Promise((resolve) => {
      const items = [...answers]
        .sort((a, b) => a.cell - b.cell)
        .map((a) =>
          h(
            'figure',
            { class: `res-item ${a.ok ? 'ok' : 'bad'}` },
            h('div', { class: 'res-thumb' }, renderThumb(this.board.strokes[a.cell], a.cell + 1)),
            h(
              'figcaption',
              {},
              h('b', {}, a.word),
              !a.ok && h('small', {}, a.answer === null ? 'не вспомнили' : h('s', {}, a.answer)),
            ),
          ),
        );
      this.root.append(
        h(
          'div',
          { class: 'results paper-bg' },
          h('h1', {}, `Раунд ${this.info.round} завершён`),
          h('div', { class: `results-score ${score < 0 ? 'neg' : 'pos'}` }, signed(score), h('small', {}, points(score))),
          h('p', { class: 'results-summary' }, `Верно ${correct} из ${answers.length} · всего ${progress.score} ${points(progress.score)}`),
          h('div', { class: 'results-grid' }, ...items),
          h(
            'div',
            { class: 'results-actions' },
            h('button', { class: next !== null ? 'btn btn-light' : 'btn btn-lg', onclick: () => resolve('menu') }, 'На главную'),
            next !== null && h('button', { class: 'btn btn-lg', onclick: () => resolve(next) }, `Раунд ${next}`, icon('play')),
          ),
        ),
      );
    });
  }

  private failure(): Promise<RoundExit> {
    return new Promise((resolve) => {
      this.root.append(
        h(
          'div',
          { class: 'overlay' },
          h(
            'div',
            { class: 'dialog' },
            h('h2', {}, 'Не загрузилось'),
            h('p', {}, 'Не получилось загрузить голос раунда. Проверьте интернет и попробуйте ещё раз.'),
            h('button', { class: 'btn', onclick: () => resolve('menu') }, 'На главную'),
          ),
        ),
      );
    });
  }

  // ——— Опрос ———

  private ask(cell: number): Promise<string | null> {
    const { question, input, form, dunno, feedback } = this.ui;
    question.replaceChildren('Что было в ячейке ', h('b', {}, `№${cell + 1}`), '?');
    input.value = '';
    input.readOnly = false;
    dunno.hidden = false;
    feedback.hidden = true;
    input.focus({ preventScroll: true });
    return new Promise((resolve) => {
      const settle = (answer: string | null) => {
        form.onsubmit = null;
        dunno.onclick = null;
        // Поле остаётся в фокусе, чтобы клавиатура телефона не прыгала между вопросами.
        input.readOnly = true;
        resolve(answer);
      };
      form.onsubmit = () => {
        const text = input.value.trim();
        if (text) settle(text);
        else input.focus();
      };
      dunno.onclick = () => settle(null);
    });
  }

  private showFeedback(ok: boolean, word: string) {
    const { dunno, feedback } = this.ui;
    dunno.hidden = true;
    feedback.hidden = false;
    feedback.className = `quiz-feedback ${ok ? 'ok' : 'bad'}`;
    feedback.textContent = ok ? 'Верно! +1' : `Правильный ответ: «${word}». −1`;
  }

  private sayNumber(cell: number) {
    if (!this.sound) return;
    const c = this.info.cells[cell];
    // Номер вырезаем из дорожки диктовки. Вокруг него секунда тишины,
    // так что запас по краям покрывает задержку MP3-декодера.
    this.numberVoice?.stop();
    this.numberVoice = this.say(this.sound.dictation, Math.max(0, c.numberStartMs - 80) / 1000, (c.numberMs + 240) / 1000);
  }

  // ——— Кадр, пауза, ввод ———

  private tick = (t: number) => {
    this.raf = requestAnimationFrame(this.tick);
    const running = audio.ctx.state === 'running';
    if (this.drawing) {
      // Рисование не ждёт: без звука время всё равно идёт, а голос потом догонит его.
      if (this.ui.soundHint.hidden !== running) this.ui.soundHint.hidden = running;
      const now = wallNow();
      this.track?.sync(now);
      if (this.phase === 'draw') this.trackDictation(now);
      else this.trackFinal(now);
    } else if (!this.paused && !running) {
      // Браузер мог остановить звук сам (звонок, переключение приложений) — тогда и игра на паузе.
      this.pause();
    }
    const now = audio.ctx.currentTime;
    for (const timer of this.timers) {
      if (now >= timer.at) {
        this.timers.delete(timer);
        timer.done();
      }
    }
    if (this.phase !== 'results') this.board.render(t);
  };

  private get drawing() {
    return this.phase === 'draw' || this.phase === 'final';
  }

  /** Пауза есть только до рисования и в опросе: рисование не ждёт, а в итогах останавливать нечего. */
  private get pausable() {
    return this.phase === 'ready' || this.phase === 'quiz';
  }

  private trackDictation(now: number) {
    if (now >= this.dictationEnd) {
      this.endPhase?.();
      return;
    }
    const ms = (now - this.dictationStart) * 1000;
    const cells = this.info.cells;
    let current = -1;
    while (current + 1 < cells.length && cells[current + 1].numberStartMs <= ms) current++;
    this.setHighlight(current < 0 ? null : current);
    this.ui.bar.style.width = `${Math.min(100, (ms / this.info.dictationMs) * 100)}%`;
  }

  private trackFinal(now: number) {
    const left = Math.max(0, this.finalEnd - now);
    const second = Math.ceil(left);
    this.ui.bar.style.width = `${(left / FINAL_SECONDS) * 100}%`;
    if (second !== this.shownSecond) {
      this.shownSecond = second;
      this.ui.status.textContent = `Осталось 0:${String(second).padStart(2, '0')}`;
      this.ui.status.classList.toggle('urgent', second <= URGENT_SECONDS);
      if (second > 0 && second <= URGENT_SECONDS && audio.ctx.state === 'running') audio.sfx('tick');
    }
    if (left <= 0) this.endPhase?.();
  }

  private setHighlight(cell: number | null) {
    if (cell === this.highlight) return;
    this.highlight = cell;
    this.board.highlight = cell;
    this.ui.status.textContent = cell === null ? 'Слушайте' : `Ячейка №${cell + 1}`;
    this.updateTools();
  }

  /** Куда ведёт кнопка со стрелкой: на следующую ячейку, а с общего вида — на ту, что диктуют. */
  private nextCell() {
    const focused = this.board.focused;
    return focused === null ? (this.highlight ?? 0) : (focused + 1) % CELLS;
  }

  /** Ячейка, о которой голос уже договорил: пока он диктует №25, это №24, а после диктовки — №25. */
  private spokenCell(): number | null {
    if (this.phase === 'final') return CELLS - 1;
    return this.highlight !== null && this.highlight > 0 ? this.highlight - 1 : null;
  }

  private updateTools() {
    const { undo, zoom, spoken, next } = this.ui;
    const focused = this.board.focused;
    const said = this.spokenCell();
    undo.disabled = !this.board.canUndo();
    zoom.disabled = focused === null;
    spoken.disabled = said === null || said === focused;
    spoken.querySelector('span')!.textContent = said === null ? '№—' : `№${said + 1}`;
    next.querySelector('span')!.textContent = `№${this.nextCell() + 1}`;
    // С правого края следующая ячейка — в начале нового ряда, рядом её не видно: подсказываем кнопку.
    next.classList.toggle('hint', focused !== null && focused % GRID === GRID - 1);
  }

  private syncInsets() {
    const bottom = Math.max(this.ui.tools.offsetHeight, this.ui.quiz.offsetHeight);
    this.board.setInsets(this.ui.top.offsetHeight, bottom);
  }

  /** Пока рисуют, вместо паузы — выход: диктовку остановить нельзя. */
  private updateMenuButton() {
    const { menu } = this.ui;
    menu.replaceChildren(icon(this.drawing ? 'close' : 'pause'));
    menu.setAttribute('aria-label', this.drawing ? 'Выйти из раунда' : 'Пауза');
  }

  private confirmExit() {
    if (this.exitDialog) return;
    this.exitDialog = h(
      'div',
      { class: 'overlay' },
      h(
        'div',
        { class: 'dialog' },
        h('h2', {}, 'Выйти?'),
        h('p', {}, 'Раунд не ждёт: пока открыто это окно, диктовка и время идут. Если выйти, результат не сохранится.'),
        h('button', { class: 'btn', onclick: () => this.closeExitDialog() }, 'Рисовать дальше'),
        h('button', { class: 'btn btn-light', onclick: () => this.exit() }, 'Выйти в меню'),
      ),
    );
    this.root.append(this.exitDialog);
  }

  private closeExitDialog() {
    this.exitDialog?.remove();
    this.exitDialog = null;
  }

  private pause() {
    if (this.paused || !this.pausable) return;
    audio.suspend();
    this.paused = h(
      'div',
      { class: 'overlay' },
      h(
        'div',
        { class: 'dialog' },
        h('h2', {}, 'Пауза'),
        h('p', {}, 'Раунд остановлен. Если выйти, результат не сохранится.'),
        h('button', { class: 'btn', onclick: () => this.resume() }, icon('play'), 'Продолжить'),
        h('button', { class: 'btn btn-light', onclick: () => this.exit() }, 'Выйти в меню'),
      ),
    );
    this.root.append(this.paused);
  }

  private async resume() {
    await audio.resume();
    // Если браузер не дал включить звук, пауза остаётся: игрок нажмёт ещё раз.
    if (audio.ctx.state !== 'running') return;
    this.paused?.remove();
    this.paused = null;
  }

  private exit() {
    this.track = null;
    for (const voice of this.voices) voice.stop();
    void audio.resume();
    this.cancel();
  }

  private onVisibility = () => {
    // Свёрнутое приложение молчит (это делает main.ts). Подготовка и опрос встают на паузу,
    // а рисование и итоги снова зазвучат, когда игрок вернётся: диктовка — с того места, где она сейчас.
    if (this.pausable) {
      if (document.hidden) this.pause();
    } else if (!document.hidden) void audio.resume();
  };

  private onKey = (e: KeyboardEvent) => {
    if (this.paused || this.exitDialog || !this.board.interactive) return;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (moves[e.key]) this.board.step(...moves[e.key]);
    else if (e.key === 'Escape') this.board.focus(null);
    else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') this.board.undo();
    else return;
    e.preventDefault();
  };

  // ——— Служебное ———

  private say(buffer: AudioBuffer, offset?: number, duration?: number): Voice {
    const voice = audio.play(buffer, offset, duration);
    this.voices.add(voice);
    void voice.ended.then(() => this.voices.delete(voice));
    return voice;
  }

  /** Обрывает ожидание, если игрок вышел из раунда. */
  private guard<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([promise, this.cancelled]);
  }

  private wait(ms: number): Promise<void> {
    return this.guard(new Promise<void>((done) => this.timers.add({ at: audio.ctx.currentTime + ms / 1000, done })));
  }

  /** Ждёт, но нажатие (или Enter в поле ответа) пропускает ожидание. */
  private waitOrTap(ms: number, el: HTMLElement): Promise<void> {
    return this.guard(
      new Promise<void>((resolve) => {
        const events = ['pointerdown', 'submit'];
        const finish = () => {
          this.timers.delete(timer);
          clearTimeout(arm);
          for (const type of events) el.removeEventListener(type, finish);
          resolve();
        };
        const timer = { at: audio.ctx.currentTime + ms / 1000, done: finish };
        this.timers.add(timer);
        // Слушаем не сразу: нажатие, которое сюда привело, ещё может всплывать.
        const arm = setTimeout(() => events.forEach((type) => el.addEventListener(type, finish)), 200);
      }),
    );
  }

  private dispose() {
    cancelAnimationFrame(this.raf);
    for (const voice of this.voices) voice.stop();
    this.timers.clear();
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('keydown', this.onKey);
    this.resizeObserver.disconnect();
    this.board.destroy();
    if (import.meta.env.DEV) Object.assign(window, { __round: undefined });
  }
}
