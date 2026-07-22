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
  /** Compressed video samples/tags observed by the active media pipeline. */
  videoTagCount: number;
  audioSampleCount: number;
  /** DOM diagnostics scoped to this player's container. */
  videoElementCount: number;
  canvasCount: number;
  fps: number;
  decodedFrames: number;
  droppedFrames: number;
  audioQueueMs: number;
  audioDecodedFrames: number;
  audioScheduledSources: number;
  audioFrameSamples: number;
  audioContextState: string;
  audioTimelineResets: number;
  audioUnderruns: number;
  audioStartupBufferMs: number;
  audioDroppedSamples: number;
  videoQueueLength: number;
  currentTime: number;
  currentTimeMs: number;
  duration: number;
  firstFrameTimeMs: number;
  bitrate: number;
  reconnectCount: number;
  discontinuityCount: number;
  downloadedBytes: number;
  totalBytes: number;
  lastError: string;
}

function createInitialStats(): TeslaPlayerStats {
  return {
    sourceType: 'unknown',
    decoderType: 'none',
    rendererType: 'none',
    audioType: 'none',
    videoTagCount: 0,
    audioSampleCount: 0,
    videoElementCount: 0,
    canvasCount: 0,
    fps: 0,
    decodedFrames: 0,
    droppedFrames: 0,
    audioQueueMs: 0,
    audioDecodedFrames: 0,
    audioScheduledSources: 0,
    audioFrameSamples: 0,
    audioContextState: 'closed',
    audioTimelineResets: 0,
    audioUnderruns: 0,
    audioStartupBufferMs: 0,
    audioDroppedSamples: 0,
    videoQueueLength: 0,
    currentTime: 0,
    currentTimeMs: 0,
    duration: 0,
    firstFrameTimeMs: 0,
    bitrate: 0,
    reconnectCount: 0,
    discontinuityCount: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    lastError: ''
  };
}

export class PlayerStatsTracker {
  private stats = createInitialStats();
  private frameTicks = 0;
  private lastFpsAt = now();

  constructor(private scope?: Pick<ParentNode, 'querySelectorAll'>) {}

  setScope(scope?: Pick<ParentNode, 'querySelectorAll'>): void {
    this.scope = scope;
  }

  resetSession(values: Partial<TeslaPlayerStats> = {}): void {
    this.stats = { ...createInitialStats(), ...values };
    this.frameTicks = 0;
    this.lastFpsAt = now();
  }

  patch(values: Partial<TeslaPlayerStats>): void {
    this.stats = { ...this.stats, ...values };
  }

  incrementReconnect(): void {
    this.stats.reconnectCount += 1;
  }

  markDiscontinuity(): void {
    this.stats.discontinuityCount += 1;
  }

  markDecoded(): void {
    this.stats.decodedFrames += 1;
  }

  markDropped(): void {
    this.stats.droppedFrames += 1;
  }

  markAudioDropped(count = 1): void {
    this.stats.audioDroppedSamples += Math.max(0, Math.floor(count));
  }

  markRendered(): void {
    this.frameTicks += 1;
    const current = now();
    const elapsed = current - this.lastFpsAt;
    if (elapsed >= 1000) {
      this.stats.fps = Math.round((this.frameTicks * 1000) / elapsed);
      this.frameTicks = 0;
      this.lastFpsAt = current;
    }
  }

  snapshot(): TeslaPlayerStats {
    if (this.scope) {
      this.stats.videoElementCount = this.scope.querySelectorAll('video').length;
      this.stats.canvasCount = this.scope.querySelectorAll('canvas').length;
    }
    return { ...this.stats };
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
