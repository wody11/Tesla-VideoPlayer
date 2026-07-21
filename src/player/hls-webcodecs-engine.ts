import { WebAudioPlayer } from '../audio/webaudio-player';
import { WebCodecsDecoder } from '../decoder/webcodecs-decoder';
import { CanvasRenderer } from '../render/canvas-renderer';
import { WebGLRenderer } from '../render/webgl-renderer';
import { detectCapability } from '../utils/capability';
import { PlayerEvents } from './player-events';
import { PlayerStateMachine } from './player-state';
import { PlayerStatsTracker, TeslaPlayerStats } from './player-stats';
import { PLAYBACK_PRESETS, PlaybackPresetName } from './playback-strategy';
import type { TeslaWorkerEvent } from '../worker/worker-protocol';
import { SessionGeneration } from '../utils/session-generation';
import { canDecodeVideo, trimLiveVideoQueue } from './playback-flow';

// Tesla no-video engine: MP4/HLS/FLV -> worker demux -> WebCodecs -> Canvas/WebGL/WebAudio.
export interface HlsWebCodecsEngineOptions {
  container: HTMLElement;
  renderer?: 'canvas2d' | 'webgl';
  workerUrl?: string;
  fitMode?: 'contain' | 'cover' | 'fill';
  preset?: PlaybackPresetName;
  liveStartSegmentCount?: number;
  liveSegmentBatch?: number;
  audioMaxQueueMs?: number;
  decodeBatchSize?: number;
  maxRenderQueue?: number;
  lateDropMs?: number;
}

export class HlsWebCodecsEngine {
  readonly events = new PlayerEvents();
  private state = new PlayerStateMachine();
  private stats = new PlayerStatsTracker();
  private sessions = new SessionGeneration();
  private canvas: HTMLCanvasElement;
  private renderer: CanvasRenderer | WebGLRenderer;
  private audio?: WebAudioPlayer;
  private decoder?: WebCodecsDecoder;
  private worker?: Worker;
  private firstFrameStart = 0;
  private firstFrameSeen = false;
  private videoQueueLength = 0;
  private stopped = true;
  private paused = false;
  private pausedAtMs = 0;
  private sourceType: 'hls' | 'mp4' | 'http-flv' | 'ws-flv' = 'hls';
  private currentUrl = '';
  private mp4PullOutstanding = 0;
  private videoConfigured = false;
  private audioConfigured = false;
  private seenKeyFrame = false;
  private pendingVideoSamples: Array<{ data: ArrayBuffer; timestamp: number; duration?: number; key: boolean }> = [];
  private pendingAudioSamples: Array<{ data: ArrayBuffer; timestamp: number; duration?: number }> = [];
  private videoWallClockBaseUs?: number;
  private videoWallClockBaseMs?: number;
  private renderQueue: Array<{ frame: any; timestamp: number }> = [];
  private renderLoopId?: number;
  private decodePumpId?: number;
  private settings = {
    fitMode: 'contain' as 'contain' | 'cover' | 'fill',
    preset: 'balanced' as PlaybackPresetName,
    liveStartSegmentCount: 1,
    liveSegmentBatch: 1,
    audioMaxQueueMs: 1500,
    decodeBatchSize: 8,
    maxRenderQueue: 120,
    lateDropMs: 240
  };

  constructor(private options: HlsWebCodecsEngineOptions) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.maxWidth = '100%';
    this.canvas.style.maxHeight = '100%';
    this.canvas.style.position = 'absolute';
    this.canvas.style.inset = '0';
    this.canvas.style.display = 'block';
    this.canvas.style.objectFit = 'contain';
    this.canvas.style.background = '#000';
    options.container.appendChild(this.canvas);
    this.updateSettings(options);
    this.renderer = this.createRenderer(options.renderer || 'webgl');
    this.stats.patch({ rendererType: this.renderer.type });
    this.stats.patch({ sourceType: 'hls', audioType: 'webaudio' });
  }

  on = this.events.on.bind(this.events);

  async play(url: string, sourceType: 'hls' | 'mp4' | 'http-flv' | 'ws-flv' = 'hls', startTime = 0): Promise<void> {
    if (!url) throw new Error('Playback URL is required.');

    // Make every callback from the previous playback stale before releasing it.
    const sessionId = this.sessions.begin();
    this.releasePlaybackResources();
    this.stopped = false;
    this.paused = false;
    this.sourceType = sourceType;
    this.currentUrl = url;
    this.mp4PullOutstanding = 0;
    this.firstFrameStart = performance.now();
    this.firstFrameSeen = false;
    this.state.transition('loading');
    this.events.emit('state', this.state.current);

    const capability = detectCapability(this.canvas);
    if (!capability.supported) {
      this.stats.patch({ decoderType: 'unsupported' });
      const error = new Error(capability.reason || 'Required browser capability is not available.');
      this.fail(error, sessionId);
      throw error;
    }

    try {
      const audio = new WebAudioPlayer();
      this.audio = audio;
      audio.setMaxQueueMs(this.settings.audioMaxQueueMs);
      audio.resume().catch(error => {
        if (this.sessions.isCurrent(sessionId)) {
          this.events.emit('log', `AudioContext resume is pending or blocked: ${error?.message || error}`);
        }
      });

      const decoder = new WebCodecsDecoder({
        onVideoFrame: frame => this.handleVideoFrame(frame, sessionId),
        onAudioFrame: frame => this.handleAudioFrame(frame, sessionId),
        onError: error => this.fail(error, sessionId)
      });
      this.decoder = decoder;
      this.stats.patch({ decoderType: 'webcodecs' });

      const worker = new Worker(this.options.workerUrl || new URL('./worker-entry.js', import.meta.url), { type: 'module' });
      this.worker = worker;
      worker.onmessage = event => this.handleWorkerEvent(event.data as TeslaWorkerEvent, sessionId);
      worker.onerror = event => this.fail(new Error(event.message || 'Playback worker failed.'), sessionId);
      if (sourceType === 'mp4') worker.postMessage({ type: 'open-mp4', url, startTime });
      else if (sourceType === 'hls') worker.postMessage({
        type: 'open-hls', url,
        liveStartSegmentCount: this.settings.liveStartSegmentCount,
        liveSegmentBatch: this.settings.liveSegmentBatch,
        startTime
      });
      else worker.postMessage({ type: sourceType === 'ws-flv' ? 'open-ws-flv' : 'open-http-flv', url });
    } catch (error: any) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.fail(normalized, sessionId);
      throw normalized;
    }
  }

  pause(): void {
    if (this.paused || this.stopped) return;
    this.paused = true;
    this.pausedAtMs = performance.now();
    this.worker?.postMessage({ type: 'pause' });
    this.audio?.pause();
    this.state.transition('paused');
    this.events.emit('state', this.state.current);
  }

  async resume(): Promise<void> {
    if (!this.paused || this.stopped) return;
    const sessionId = this.sessions.current;
    const pausedDuration = performance.now() - this.pausedAtMs;
    if (this.videoWallClockBaseMs !== undefined) this.videoWallClockBaseMs += pausedDuration;
    await this.audio?.resume();
    if (!this.sessions.isCurrent(sessionId)) return;
    this.paused = false;
    this.worker?.postMessage({ type: 'resume' });
    this.state.transition('playing');
    this.events.emit('state', this.state.current);
    if (this.pendingVideoSamples.length || this.pendingAudioSamples.length) this.ensureDecodePump(sessionId);
    if (this.renderQueue.length) this.ensureRenderLoop(sessionId);
  }

  async seek(time: number): Promise<void> {
    if (this.sourceType !== 'mp4' && this.sourceType !== 'hls') throw new Error('seek() is available for MP4 and HLS on-demand playback only.');
    this.state.transition('seeking');
    this.events.emit('state', this.state.current);
    await this.play(this.currentUrl, this.sourceType, Math.max(0, Number(time) || 0));
  }

  stop(): void {
    this.sessions.invalidate();
    this.releasePlaybackResources();
    this.state.transition('stopped');
    this.events.emit('state', this.state.current);
  }

  destroy(): void {
    this.sessions.invalidate();
    this.releasePlaybackResources();
    this.events.clear();
    this.renderer.destroy();
    this.canvas.remove();
    this.state.transition('destroyed');
  }

  setVolume(value: number): void {
    this.audio?.setVolume(value);
  }

  getStats(): TeslaPlayerStats {
    const audioDiagnostics = this.audio?.diagnostics();
    this.stats.patch({
      audioQueueMs: this.audio?.queuedMs() || 0,
      audioDecodedFrames: audioDiagnostics?.enqueuedFrames || 0,
      audioScheduledSources: audioDiagnostics?.scheduledSources || 0,
      audioFrameSamples: audioDiagnostics?.lastFrameSamples || 0,
      audioContextState: audioDiagnostics?.contextState || 'closed',
      videoQueueLength: this.videoQueueLength,
      currentTimeMs: this.audio?.currentTimeMs() || 0
    });
    return this.stats.snapshot();
  }

  setRenderer(type: 'canvas2d' | 'webgl'): void {
    this.renderer.destroy();
    this.renderer = this.createRenderer(type);
    this.stats.patch({ rendererType: this.renderer.type });
  }

  updateSettings(values: Partial<HlsWebCodecsEngineOptions>): void {
    if (values.preset) {
      const preset = PLAYBACK_PRESETS[values.preset];
      if (preset) {
        this.settings = { ...this.settings, ...preset };
        this.audio?.setMaxQueueMs(this.settings.audioMaxQueueMs);
      }
    }
    if (values.fitMode) {
      this.settings.fitMode = values.fitMode;
      this.canvas.style.objectFit = values.fitMode === 'fill' ? 'fill' : values.fitMode;
    }
    if (typeof values.liveStartSegmentCount === 'number') this.settings.liveStartSegmentCount = Math.max(1, Math.min(3, values.liveStartSegmentCount));
    if (typeof values.liveSegmentBatch === 'number') this.settings.liveSegmentBatch = Math.max(1, Math.min(3, values.liveSegmentBatch));
    if (typeof values.audioMaxQueueMs === 'number') {
      this.settings.audioMaxQueueMs = Math.max(300, Math.min(5000, values.audioMaxQueueMs));
      this.audio?.setMaxQueueMs(this.settings.audioMaxQueueMs);
    }
    if (typeof values.decodeBatchSize === 'number') this.settings.decodeBatchSize = Math.max(1, Math.min(24, values.decodeBatchSize));
    if (typeof values.maxRenderQueue === 'number') this.settings.maxRenderQueue = Math.max(30, Math.min(240, values.maxRenderQueue));
    if (typeof values.lateDropMs === 'number') this.settings.lateDropMs = Math.max(80, Math.min(1000, values.lateDropMs));
  }

  private createRenderer(type: 'canvas2d' | 'webgl'): CanvasRenderer | WebGLRenderer {
    if (type === 'canvas2d') return new CanvasRenderer(this.canvas);
    try {
      return new WebGLRenderer(this.canvas);
    } catch {
      return new CanvasRenderer(this.canvas);
    }
  }

  private handleWorkerEvent(message: TeslaWorkerEvent, sessionId: number): void {
    if (!this.sessions.isCurrent(sessionId) || this.stopped) return;
    try {
      if (message.type === 'stream-open') {
        this.events.emit('log', 'Stream opened.');
      } else if (message.type === 'stream-end') {
        this.events.emit('log', 'Stream ended.');
      } else if (message.type === 'media-info') {
        this.stats.patch({ duration: message.duration });
        this.events.emit('log', `Media info: ${message.videoCodec || 'no video'} / ${message.audioCodec || 'no audio'}, ${message.duration.toFixed(2)}s.`);
        this.ensureMp4Pull();
      } else if (message.type === 'video-config') {
        this.events.emit('log', `Video config received: ${message.codec}${message.annexb ? ' annexb' : ''}`);
        const decoder = this.decoder;
        decoder?.configureVideo(message).then(() => {
          if (!this.sessions.isCurrent(sessionId) || decoder !== this.decoder) return;
          this.videoConfigured = true;
          this.events.emit('log', `VideoDecoder configured, queued video samples: ${this.pendingVideoSamples.length}.`);
          this.ensureDecodePump(sessionId);
        }).catch(error => this.fail(error, sessionId));
      } else if (message.type === 'audio-config') {
        this.events.emit('log', `Audio config received: ${message.codec} ${message.sampleRate}Hz/${message.numberOfChannels}ch`);
        const decoder = this.decoder;
        decoder?.configureAudio(message).then(() => {
          if (!this.sessions.isCurrent(sessionId) || decoder !== this.decoder) return;
          this.audioConfigured = true;
          this.ensureDecodePump(sessionId);
        }).catch(error => this.fail(error, sessionId));
      } else if (message.type === 'video-sample') {
        if (this.sourceType === 'mp4') this.mp4PullOutstanding = Math.max(0, this.mp4PullOutstanding - 1);
        if (!this.seenKeyFrame) {
          if (!message.key) return;
          this.seenKeyFrame = true;
        }
        this.videoQueueLength += 1;
        this.pendingVideoSamples.push(message);
        if (this.sourceType !== 'mp4') {
          const maxPending = Math.max(120, this.settings.maxRenderQueue * 4);
          const dropped = trimLiveVideoQueue(this.pendingVideoSamples, maxPending);
          if (dropped > 0) {
            this.videoQueueLength = Math.max(0, this.videoQueueLength - dropped);
            for (let i = 0; i < dropped; i += 1) this.stats.markDropped();
            this.seenKeyFrame = this.pendingVideoSamples.length > 0;
          }
        }
        if (this.videoConfigured) this.ensureDecodePump(sessionId);
      } else if (message.type === 'audio-sample') {
        if (this.sourceType === 'mp4') this.mp4PullOutstanding = Math.max(0, this.mp4PullOutstanding - 1);
        this.pendingAudioSamples.push(message);
        if (this.audioConfigured) this.ensureDecodePump(sessionId);
      } else if (message.type === 'stats') {
        this.stats.patch({ videoTagCount: message.videoTagCount, audioSampleCount: message.audioTagCount });
      } else if (message.type === 'log') {
        this.events.emit('log', message.message);
      } else if (message.type === 'error') {
        this.fail(new Error(message.message), sessionId);
      }
    } catch (error: any) {
      this.fail(error instanceof Error ? error : new Error(String(error)), sessionId);
    }
  }

  private handleVideoFrame(frame: any, sessionId: number): void {
    if (!this.sessions.isCurrent(sessionId)) {
      try { frame.close(); } catch {}
      return;
    }
    const timestamp = typeof frame.timestamp === 'number' ? frame.timestamp : 0;
    if (this.videoWallClockBaseUs === undefined) {
      this.videoWallClockBaseUs = timestamp;
      this.videoWallClockBaseMs = performance.now();
    }

    this.stats.markDecoded();
    this.renderQueue.push({ frame, timestamp });
    this.renderQueue.sort((a, b) => a.timestamp - b.timestamp);
    while (this.renderQueue.length > this.settings.maxRenderQueue) {
      const old = this.renderQueue.shift();
      try { old?.frame.close(); } catch {}
      this.videoQueueLength = Math.max(0, this.videoQueueLength - 1);
      this.stats.markDropped();
    }
    this.ensureRenderLoop(sessionId);
    if (this.pendingVideoSamples.length > 0) this.ensureDecodePump(sessionId);
  }

  private handleAudioFrame(frame: any, sessionId: number): void {
    if (!this.sessions.isCurrent(sessionId)) {
      try { frame.close(); } catch {}
      return;
    }
    try {
      this.audio?.enqueue(frame);
    } finally {
      frame.close();
    }
  }

  private fail(error: Error, sessionId = this.sessions.current): void {
    if (!this.sessions.isCurrent(sessionId)) return;
    this.sessions.invalidate();
    this.releasePlaybackResources();
    this.stats.patch({ lastError: error.message });
    this.state.transition('error');
    this.events.emit('state', this.state.current);
    this.events.emit('error', error);
  }

  private ensureRenderLoop(sessionId = this.sessions.current): void {
    if (!this.sessions.isCurrent(sessionId) || this.renderLoopId !== undefined) return;
    this.renderLoopId = window.setTimeout(() => this.renderTick(sessionId), 8);
  }

  private ensureDecodePump(sessionId = this.sessions.current, delayMs = 0): void {
    if (!this.sessions.isCurrent(sessionId) || this.decodePumpId !== undefined) return;
    this.decodePumpId = window.setTimeout(() => this.decodeTick(sessionId), delayMs);
  }

  private decodeTick(sessionId: number): void {
    this.decodePumpId = undefined;
    if (!this.sessions.isCurrent(sessionId) || this.stopped || this.paused) return;

    let videoBudget = this.settings.decodeBatchSize;
    while (videoBudget > 0 && canDecodeVideo(
      this.videoConfigured,
      this.pendingVideoSamples.length,
      this.renderQueue.length,
      this.decoder?.videoDecodeQueueSize() || 0,
      this.settings.maxRenderQueue
    )) {
      const sample = this.pendingVideoSamples.shift()!;
      this.decoder?.decodeVideo(sample);
      videoBudget -= 1;
    }

    // Audio has its own budget. Sharing the video budget starves AAC whenever
    // a live segment leaves a persistent video backlog.
    let audioBudget = Math.max(4, this.settings.decodeBatchSize * 2);
    while (this.audioConfigured && audioBudget > 0 && this.pendingAudioSamples.length > 0
      && (this.audio?.queuedMs() || 0) < this.settings.audioMaxQueueMs * 1.25
      && (this.decoder?.audioDecodeQueueSize() || 0) < 32) {
      this.decoder?.decodeAudio(this.pendingAudioSamples.shift()!);
      audioBudget -= 1;
    }

    this.ensureMp4Pull();
    const videoCanContinue = canDecodeVideo(
      this.videoConfigured,
      this.pendingVideoSamples.length,
      this.renderQueue.length,
      this.decoder?.videoDecodeQueueSize() || 0,
      this.settings.maxRenderQueue
    );
    const audioCanContinue = this.audioConfigured && this.pendingAudioSamples.length > 0
      && (this.audio?.queuedMs() || 0) < this.settings.audioMaxQueueMs * 1.25
      && (this.decoder?.audioDecodeQueueSize() || 0) < 32;
    if (videoCanContinue || audioCanContinue) {
      this.ensureDecodePump(sessionId);
    } else if (this.pendingVideoSamples.length > 0 || this.pendingAudioSamples.length > 0) {
      this.ensureDecodePump(sessionId, 12);
    }
  }

  private renderTick(sessionId: number): void {
    this.renderLoopId = undefined;
    if (!this.sessions.isCurrent(sessionId)) return;
    if (this.stopped) {
      this.clearRenderQueue();
      return;
    }
    if (this.paused) return;

    while (this.renderQueue.length > 0 && this.videoDelayMs(this.renderQueue[0].timestamp) < -this.settings.lateDropMs) {
      const late = this.renderQueue.shift();
      try { late?.frame.close(); } catch {}
      this.videoQueueLength = Math.max(0, this.videoQueueLength - 1);
      this.stats.markDropped();
    }

    if (this.renderQueue.length > 0) {
      const delayMs = this.videoDelayMs(this.renderQueue[0].timestamp);
      if ((!this.firstFrameSeen && delayMs > 250) || delayMs <= 12) {
        const current = this.renderQueue.shift()!;
        this.drawVideoFrame(current.frame);
      }
    }

    while (this.renderQueue.length > this.settings.maxRenderQueue) {
      const old = this.renderQueue.shift();
      try { old?.frame.close(); } catch {}
        this.videoQueueLength = Math.max(0, this.videoQueueLength - 1);
        this.stats.markDropped();
    }

    if (this.renderQueue.length > 0) this.ensureRenderLoop(sessionId);
    this.ensureMp4Pull();
  }

  private videoDelayMs(timestamp: number): number {
    const audioDelay = this.audioConfigured ? this.audio?.delayUntilMediaTimeMs(timestamp) : undefined;
    if (audioDelay !== undefined) return audioDelay;
    if (this.videoWallClockBaseUs !== undefined && this.videoWallClockBaseMs !== undefined) {
      return this.videoWallClockBaseMs + (timestamp - this.videoWallClockBaseUs) / 1000 - performance.now();
    }
    return 0;
  }

  private drawVideoFrame(frame: any): void {
    try {
      this.renderer.draw(frame);
      this.stats.markRendered();
      if (!this.firstFrameSeen) {
        this.firstFrameSeen = true;
        const firstFrameTimeMs = Math.round(performance.now() - this.firstFrameStart);
        this.stats.patch({ firstFrameTimeMs });
        this.state.transition('playing');
        this.events.emit('state', this.state.current);
        this.events.emit('firstFrame', firstFrameTimeMs);
      }
    } finally {
      this.videoQueueLength = Math.max(0, this.videoQueueLength - 1);
      try { frame.close(); } catch {}
    }
  }

  private releasePlaybackResources(): void {
    this.stopped = true;
    this.paused = false;
    const worker = this.worker;
    this.worker = undefined;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      try { worker.postMessage({ type: 'stop' }); } catch {}
      worker.terminate();
    }
    this.decoder?.close();
    this.decoder = undefined;
    this.audio?.close();
    this.audio = undefined;
    this.videoQueueLength = 0;
    this.videoConfigured = false;
    this.audioConfigured = false;
    this.seenKeyFrame = false;
    this.pendingVideoSamples = [];
    this.pendingAudioSamples = [];
    this.mp4PullOutstanding = 0;
    this.videoWallClockBaseUs = undefined;
    this.videoWallClockBaseMs = undefined;
    this.clearDecodePump();
    this.clearRenderQueue();
    try { this.renderer.clear(); } catch {}
  }

  private clearRenderQueue(): void {
    if (this.renderLoopId !== undefined) {
      clearTimeout(this.renderLoopId);
      this.renderLoopId = undefined;
    }
    for (const item of this.renderQueue) {
      try { item.frame.close(); } catch {}
    }
    this.renderQueue = [];
  }

  private clearDecodePump(): void {
    if (this.decodePumpId !== undefined) {
      clearTimeout(this.decodePumpId);
      this.decodePumpId = undefined;
    }
  }

  private ensureMp4Pull(): void {
    if (this.sourceType !== 'mp4' || this.stopped || this.paused || !this.worker) return;
    const buffered = this.pendingVideoSamples.length + this.pendingAudioSamples.length + this.renderQueue.length;
    if (buffered + this.mp4PullOutstanding >= 320 || (this.audio?.queuedMs() || 0) > this.settings.audioMaxQueueMs * 1.5) return;
    const count = 320 - buffered - this.mp4PullOutstanding;
    this.mp4PullOutstanding += count;
    this.worker.postMessage({ type: 'pull', count });
  }
}
