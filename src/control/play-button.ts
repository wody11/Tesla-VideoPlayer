import type { TeslaPlayer } from '../player/tesla-player';

export function createPlayButton(player: TeslaPlayer): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Play';
  button.onclick = () => player.play().catch(error => player.events.emit('error', error));
  return button;
}

