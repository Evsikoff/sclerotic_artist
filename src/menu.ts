import logoUrl from '../images/logo.png';
import { audio } from './audio';
import { QUIZ_SIZE, ROUNDS, type RoundInfo } from './content';
import { progress } from './progress';
import { h, icon, points, setScreen, signed } from './ui';

export interface MenuChoice {
  round: number;
  /** Переигровка пройденного раунда: перед ней показывается реклама. */
  replay: boolean;
}

const capitalize = (s: string) => s[0].toUpperCase() + s.slice(1);

export function showMenu(): Promise<MenuChoice> {
  return new Promise((resolve) => {
    const next = progress.nextRound();
    const played = ROUNDS.filter((r) => progress.record(r.round));
    // Пока игрок в меню, заранее качаем голос следующего раунда.
    if (next !== null) audio.load(ROUNDS[next - 1].dictationUrl).catch(() => {});

    const nextCard =
      next !== null
        ? h(
            'section',
            { class: 'next-card' },
            h('div', { class: 'next-kicker' }, played.length ? 'Следующий раунд' : 'Первый раунд'),
            h('h2', {}, `Раунд ${next}`),
            h('p', {}, `Диктует ${ROUNDS[next - 1].narrator}`),
            h(
              'button',
              { class: 'btn btn-yellow btn-lg', onclick: () => resolve({ round: next, replay: false }) },
              icon('play'),
              'Играть',
            ),
          )
        : h(
            'section',
            { class: 'next-card' },
            h('h2', {}, 'Все раунды пройдены!'),
            h('p', {}, 'Новые раунды скоро появятся. А пока можно переиграть любой из пройденных.'),
          );

    const list = played.length
      ? [
          h('h3', { class: 'section-title' }, 'Пройденные раунды'),
          h('ul', { class: 'round-list' }, ...played.map((r) => roundItem(r, () => resolve({ round: r.round, replay: true })))),
        ]
      : [];

    setScreen(
      h(
        'div',
        { class: 'screen menu paper-bg' },
        h(
          'div',
          { class: 'menu-inner' },
          h('img', { class: 'menu-logo', src: logoUrl, alt: 'Художник-склеротик' }),
          h(
            'div',
            { class: 'score-pill' },
            h('span', { class: 'score-star' }, icon('star')),
            h('b', {}, signed(progress.score).replace('+', '')),
            points(progress.score),
          ),
          nextCard,
          ...list,
        ),
      ),
    );
  });
}

function roundItem(r: RoundInfo, onReplay: () => void) {
  const record = progress.record(r.round)!;
  return h(
    'li',
    { class: 'round-item' },
    h('div', { class: 'round-num' }, String(r.round)),
    h('div', { class: 'round-meta' }, h('b', {}, `Раунд ${r.round}`), h('small', {}, capitalize(r.narrator))),
    h(
      'div',
      { class: `round-result ${record.best < 0 ? 'neg' : 'pos'}` },
      h('b', {}, signed(record.best)),
      h('small', {}, `${record.bestCorrect} из ${QUIZ_SIZE}`),
    ),
    h(
      'button',
      { class: 'replay-btn', onclick: onReplay, 'aria-label': `Переиграть раунд ${r.round} после рекламы` },
      icon('replay'),
      h('small', {}, 'реклама'),
    ),
  );
}
