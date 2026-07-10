/*
 * Tesla-VideoPlayer is based on Jessibuca open source architecture.
 * Jessibuca is licensed under GPL-3.0. See THIRD_PARTY_NOTICES.md.
 */

import type { TeslaSourceType } from './player-options';

export interface TeslaPlayerStats {
  sourceType: TeslaSourceType;
  decoderType: 'webcodecs' | 'wasm' | 'unsupported' | 'none';
  rendererType: 'canvas2d' | 'webgl' | 'none';
  audioType: 'webaudio' | 'none';
  videoTagCount: number;
  audioSampleCount: number;
  canvasCount: number;
  fps: number;
  decodedFrames: number;
  droppedFrames: number;
  audioQueueMs: number;
  audioDecodedFrames: number;
  audioScheduledSources: number;
  audioFrameSamples: number;
  audioContextState: string;
  videoQueueLength: number;
  currentTime: number;
  currentTimeMs: number;
  duration: number;
  firstFrameTimeMs: number;
  bitrate: number;
  reconnectCount: number;
  lastError: string;
}

export class PlayerStatsTracker {
  private stats: TeslaPlayerStats = {
    sourceType: 'unknown',
    decoderType: 'none',
    rendererType: 'none',
    audioType: 'none',
    videoTagCount: 0,
    audioSampleCount: 0,
    canvasCount: 0,
    fps: 0,
    decodedFrames: 0,
    droppedFrames: 0,
    audioQueueMs: 0,
    audioDecodedFrames: 0,
    audioScheduledSources: 0,
    audioFrameSamples: 0,
    audioContextState: 'closed',
    videoQueueLength: 0,
    currentTime: 0,
    currentTimeMs: 0,
    duration: 0,
    firstFrameTimeMs: 0,
    bitrate: 0,
    reconnectCount: 0,
    lastError: ''
  };

  private frameTicks = 0;
  private lastFpsAt = typeof performance !== 'undefined' ? performance.now() : Date.now();

  patch(values: Partial<TeslaPlayerStats>): void {
    this.stats = { ...this.stats, ...values };
  }

  markDecoded(): void {
    this.stats.decodedFrames += 1;
  }

  markDropped(): void {
    this.stats.droppedFrames += 1;
  }

  markRendered(): void {
    this.frameTicks += 1;
    const now = performance.now();
    if (now - this.lastFpsAt >= 1000) {
      this.stats.fps = this.frameTicks;
      this.frameTicks = 0;
      this.lastFpsAt = now;
    }
  }

  snapshot(): TeslaPlayerStats {
    if (typeof document !== 'undefined') {
      this.patch({
        videoTagCount: document.querySelectorAll('video').length,
        canvasCount: document.querySelectorAll('canvas').length
      });
    }
    return { ...this.stats };
  }
}
