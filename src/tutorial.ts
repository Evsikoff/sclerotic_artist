import { h, showLayer } from './ui';

/** Заглушка обучающей презентации, которую игрок видит при первом запуске. */
export function showTutorial(): Promise<void> {
  return new Promise((resolve) => {
    const layer = h(
      'div',
      { class: 'overlay' },
      h(
        'div',
        { class: 'dialog' },
        h('h2', {}, 'Как играть'),
        h('p', {}, 'Здесь будет обучающая презентация.'),
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              layer.remove();
              resolve();
            },
          },
          'Понятно',
        ),
      ),
    );
    showLayer(layer);
  });
}
