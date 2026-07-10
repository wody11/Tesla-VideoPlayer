import type { TeslaPlayer } from '../player/tesla-player';

export function createScreenshotControl(player: TeslaPlayer): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Shot';
  button.onclick = () => {
    const url = player.screenshot();
    const link = document.createElement('a');
    link.href = url;
    link.download = `tesla-frame-${Date.now()}.png`;
    link.click();
  };
  return button;
}

