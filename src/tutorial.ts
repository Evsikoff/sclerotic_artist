import tutorialUrl from '../video/tutorial.mp4';
import { audio } from './audio';
import { h, icon, showLayer } from './ui';

/**
 * Обучающий ролик: сам при первом запуске и по кнопке «Как играть» в меню.
 * Пока он идёт, музыка игры молчит: у ролика своя дорожка с диктором и музыкой.
 */
export function showTutorial(): Promise<void> {
  return new Promise((resolve) => {
    const video = h('video', {
      class: 'tutorial-video',
      src: tutorialUrl,
      playsinline: true,
      'webkit-playsinline': true,
      preload: 'auto',
    });
    const spinner = h('div', { class: 'intro-loading', hidden: true }, h('span', { class: 'spinner' }), 'Загрузка…');
    const play = h('button', { class: 'tutorial-play', hidden: true, 'aria-label': 'Смотреть' }, icon('play'));
    const skip = h('button', { class: 'tutorial-skip' }, 'Пропустить');
    const layer = h('div', { class: 'tutorial' }, video, spinner, play, skip);

    // Без нажатия телефон может не дать включить видео со звуком: тогда ждём кнопку.
    const start = () => {
      play.hidden = true;
      video.play().catch(() => (play.hidden = !video.paused));
    };
    const pause = () => {
      video.pause();
      spinner.hidden = true;
      play.hidden = false;
    };
    const onVisibility = () => document.hidden && pause();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      // Отпускаем файл, чтобы закрытый ролик не докачивался в фоне.
      video.pause();
      video.removeAttribute('src');
      video.load();
      layer.remove();
      audio.playMusic();
      resolve();
    };

    video.addEventListener('click', () => (video.paused ? start() : pause()));
    video.addEventListener('waiting', () => (spinner.hidden = false));
    video.addEventListener('playing', () => (spinner.hidden = true));
    video.addEventListener('ended', close);
    // Ролик не загрузился (нет сети) — не держим игрока: его можно посмотреть позже из меню.
    video.addEventListener('error', close);
    play.addEventListener('click', start);
    skip.addEventListener('click', close);
    document.addEventListener('visibilitychange', onVisibility);

    audio.stopMusic();
    showLayer(layer);
    start();
  });
}
