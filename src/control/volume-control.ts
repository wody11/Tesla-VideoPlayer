import type { TeslaPlayer } from '../player/tesla-player';

export function createVolumeControl(player: TeslaPlayer): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'range';
  input.min = '0';
  input.max = '1';
  input.step = '0.01';
  input.value = '1';
  input.oninput = () => player.setVolume(Number(input.value));
  return input;
}

