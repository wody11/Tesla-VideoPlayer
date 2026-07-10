/*
 * WebAudio manager, based on Jessibuca's dedicated audio subsystem pattern.
 */

import { WebAudioPlayer } from './webaudio-player';

export class AudioManager {
  readonly type = 'webaudio' as const;
  private player?: WebAudioPlayer;

  open(maxQueueMs?: number): WebAudioPlayer {
    this.close();
    this.player = new WebAudioPlayer();
    if (maxQueueMs) this.player.setMaxQueueMs(maxQueueMs);
    return this.player;
  }

  get current(): WebAudioPlayer | undefined {
    return this.player;
  }

  close(): void {
    this.player?.close();
    this.player = undefined;
  }
}

