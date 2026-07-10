import type { TeslaPlayer } from '../player/tesla-player';

export function createStatsPanel(player: TeslaPlayer): HTMLPreElement {
  const pre = document.createElement('pre');
  pre.style.margin = '0';
  pre.style.whiteSpace = 'pre-wrap';
  const tick = () => {
    pre.textContent = JSON.stringify(player.getStats(), null, 2);
    if (player.getState() !== 'destroyed') requestAnimationFrame(tick);
  };
  tick();
  return pre;
}

