import '@fontsource/rubik/cyrillic-400.css';
import '@fontsource/rubik/cyrillic-700.css';
import '@fontsource/rubik/cyrillic-800.css';
import '@fontsource/rubik/latin-400.css';
import '@fontsource/rubik/latin-700.css';
import '@fontsource/rubik/latin-800.css';
import '@fontsource/caveat/cyrillic-700.css';
import '@fontsource/caveat/latin-700.css';
import './styles.css';
import logoUrl from '../images/logo.png';
import introUrl from '../video/intro.mp4';
import { showFullscreenAd } from './ads';
import { audio } from './audio';
import { ROUNDS } from './content';
import { showMenu } from './menu';
import { progress } from './progress';
import { playRound } from './round';
import { showTutorial } from './tutorial';
import { h, icon, setScreen } from './ui';

const SOUND_WARNING_MS = 5000;

let inRound = false;

async function main() {
  if (import.meta.env.DEV) Object.assign(window, { __audio: audio });
  trackViewport();
  const intro = await startScreen();
  watchFocus();
  const loading = preload();
  await playIntro(intro, loading);
  await soundWarning();
  await menuLoop();
}

interface Intro {
  video: HTMLVideoElement;
  started: Promise<void>;
}

function startScreen(): Promise<Intro> {
  return new Promise((resolve) => {
    const launch = () => {
      // Звук и видео со звуком браузер разрешит только здесь, синхронно в обработчике нажатия.
      audio.unlock();
      enterFullscreen();
      const video = h('video', { class: 'intro-video', src: introUrl, playsinline: true, 'webkit-playsinline': true, preload: 'auto' });
      resolve({ video, started: video.play() });
    };
    setScreen(
      h(
        'div',
        { class: 'screen start paper-bg' },
        h('img', { class: 'start-logo', src: logoUrl, alt: 'Художник-склеротик' }),
        h('button', { class: 'btn btn-xl', onclick: launch }, icon('play'), 'Запустить'),
      ),
    );
  });
}

function enterFullscreen() {
  if (!matchMedia('(pointer: coarse)').matches || !document.documentElement.requestFullscreen) return;
  const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
  document.documentElement
    .requestFullscreen({ navigationUI: 'hide' })
    .then(() => orientation.lock?.('portrait'))
    .catch(() => {});
}

function preload(): Promise<void> {
  const fonts = ['400 1em Rubik', '700 1em Rubik', '800 1em Rubik', '700 1em Caveat'].map((f) => document.fonts.load(f));
  const logo = new Image();
  logo.src = logoUrl;
  return Promise.allSettled([...fonts, logo.decode(), audio.musicReady()]).then(() => {});
}

async function playIntro({ video, started }: Intro, loading: Promise<void>) {
  const spinner = h('div', { class: 'intro-loading', hidden: true }, h('span', { class: 'spinner' }), 'Загрузка…');
  setScreen(h('div', { class: 'screen intro' }, video, spinner));
  await new Promise<void>((resolve) => {
    video.addEventListener('ended', () => resolve());
    video.addEventListener('error', () => resolve());
    started.catch(() => resolve());
    setTimeout(resolve, 20000); // страховка, если видео зависло
  });
  spinner.hidden = false;
  await loading;
}

function soundWarning(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, SOUND_WARNING_MS);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    setScreen(
      h(
        'div',
        { class: 'screen sound-warning paper-bg', onclick: done },
        h('img', { class: 'warning-logo', src: logoUrl, alt: 'Художник-склеротик' }),
        h('div', { class: 'sound-badge' }, icon('speaker')),
        h('h1', {}, 'Включите звук'),
        h('p', {}, 'С выключенным звуком играть не получится: слова для рисунков диктует голос.'),
        h('button', { class: 'btn' }, 'Звук включён'),
      ),
    );
  });
}

async function menuLoop() {
  audio.playMusic();
  for (;;) {
    const choice = showMenu();
    if (!progress.tutorialSeen) {
      await showTutorial();
      progress.markTutorialSeen();
    }
    const { round, replay } = await choice;
    inRound = true;
    audio.stopMusic();
    if (replay) await showFullscreenAd();
    let next: number | null = round;
    while (next !== null) {
      const exit = await playRound(ROUNDS[next - 1]);
      next = exit === 'menu' ? null : exit;
    }
    inRound = false;
    audio.playMusic();
  }
}

/** Свёрнутое приложение молчит. Раунд ставит себя на паузу сам, остальное просто продолжает играть. */
function watchFocus() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) audio.suspend();
    else if (!inRound) void audio.resume();
  });
  // iOS может прервать звук без спроса; вернуть его можно только по нажатию.
  window.addEventListener('pointerdown', () => inRound || void audio.resume(), true);
}

/** На телефоне клавиатура перекрывает экран: подгоняем игру под видимую часть. */
function trackViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = () => {
    document.documentElement.style.setProperty('--vv-height', `${vv.height}px`);
    document.documentElement.style.setProperty('--vv-top', `${vv.offsetTop}px`);
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
}

void main();
