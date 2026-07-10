import type { TeslaPlayer } from '../player/tesla-player';

export function createFullscreenControl(player: TeslaPlayer): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Fullscreen';
  button.onclick = () => player.fullscreen();
  return button;
}

