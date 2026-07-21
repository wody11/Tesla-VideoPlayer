/*
 * Lightweight Jessibuca-style control bar for Tesla no-video player.
 */

import type { TeslaPlayer } from '../player/tesla-player';
import { createFullscreenControl } from './fullscreen-control';
import { createPlayButton } from './play-button';
import { createScreenshotControl } from './screenshot-control';
import { createVolumeControl } from './volume-control';

export class ControlBar {
  readonly element: HTMLDivElement;

  constructor(private player: TeslaPlayer) {
    this.element = document.createElement('div');
    this.element.className = 'tesla-control-bar';
    this.element.style.cssText = 'position:absolute;left:0;right:0;bottom:0;z-index:20;display:flex;gap:8px;align-items:center;padding:8px;background:rgba(17,17,17,.85);color:#fff;';
    const pause = document.createElement('button');
    pause.type = 'button';
    pause.textContent = 'Pause';
    pause.onclick = () => this.player.pause();
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.textContent = 'Stop';
    stop.onclick = () => this.player.stop();
    this.element.append(createPlayButton(player), pause, stop, createVolumeControl(player), createFullscreenControl(player), createScreenshotControl(player));
  }

  destroy(): void {
    this.element.remove();
  }
}

