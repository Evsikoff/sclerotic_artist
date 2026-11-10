import { h, icon, showLayer } from './ui';

const STUB_SECONDS = 5;

/**
 * Заглушка полноэкранной рекламы. Сюда подключается рекламный SDK:
 * промис должен завершиться, когда игрок закрыл рекламу.
 */
export function showFullscreenAd(): Promise<void> {
  return new Promise((resolve) => {
    let left = STUB_SECONDS;
    const close = h('button', { class: 'ad-close', disabled: true, 'aria-label': 'Закрыть рекламу' }, String(left));
    const layer = h(
      'div',
      { class: 'ad-stub' },
      h('div', { class: 'ad-body' }, h('span', { class: 'ad-label' }, 'Реклама'), h('p', {}, 'Здесь будет полноэкранная реклама')),
      close,
    );
    const timer = setInterval(() => {
      left -= 1;
      if (left > 0) {
        close.textContent = String(left);
        return;
      }
      clearInterval(timer);
      close.disabled = false;
      close.replaceChildren(icon('close'));
    }, 1000);
    close.addEventListener('click', () => {
      layer.remove();
      resolve();
    });
    showLayer(layer);
  });
}
