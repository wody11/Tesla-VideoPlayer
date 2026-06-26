// Runtime counters required by the standalone acceptance page.
export interface TeslaPlayerStats {
  decoderType: 'webcodecs' | 'unsupported' | 'none';
  rendererType: 'canvas2d' | 'webgl' | 'none';
  videoTagCount: number;
  canvasCount: number;
  fps: number;
  decodedFrames: number;
  droppedFrames: number;
  audioQueueMs: number;
  videoQueueLength: number;
  firstFrameTimeMs: number;
  currentTimeMs: number;
}

export class PlayerStatsTracker {
  private stats: TeslaPlayerStats = {
    decoderType: 'none',
    rendererType: 'none',
    videoTagCount: 0,
    canvasCount: 0,
    fps: 0,
    decodedFrames: 0,
    droppedFrames: 0,
    audioQueueMs: 0,
    videoQueueLength: 0,
    firstFrameTimeMs: 0,
    currentTimeMs: 0
  };

  private frameTicks = 0;
  private lastFpsAt = performance.now();

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
    this.patch({
      videoTagCount: document.querySelectorAll('video').length,
      canvasCount: document.querySelectorAll('canvas').length
    });
    return { ...this.stats };
  }
}
