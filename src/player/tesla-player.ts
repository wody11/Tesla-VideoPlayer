/*
 * Tesla-VideoPlayer runtime uses Tesla's WebCodecs worker pipeline and the
 * vendored Jessibuca WASM runtime without HTML video or MSE fallback.
 */

import { PlayerEvents } from './player-events';
import { PlayerStateMachine } from './player-state';
import { PlayerStatsTracker, TeslaPlayerStats } from './player-stats';
import {
  inferSourceType,
  normalizePlayerOptions,
  TeslaLoadOptions,
  TeslaPlayerOptions,
  TeslaSourceType
} from './player-options';
import { NoVideoGuard } from '../utils/no-video-guard';
import { HlsWebCodecsEngine, HlsWebCodecsEngineOptions } from './hls-webcodecs-engine';
import { H265WebEngine } from './h265web-engine';
import { resolveEngineRoute } from './engine-routing';
import { ControlBar } from '../control/control-bar';

type JessibucaInstance = {
  play(url?: string, options?: any): Promise<void>;
  pause(): Promise<void>;
  close(): void;
  destroy(): void;
  setVolume(volume: number): void;
  screenshot(filename?: string, format?: string, quality?: number, type?: string): any;
  on(event: string, handler: (...args: any[]) => void): void;
  off?: (event: string, handler: (...args: any[]) => void) => void;
};

declare global {
  interface Window {
    Jessibuca?: new (config: any) => JessibucaInstance;
  }
}

let jessibucaLoader: Promise<void> | undefined;

function loadJessibuca(scriptUrl = new URL('./jessibuca.js', import.meta.url).href): Promise<void> {
  if (window.Jessibuca) return Promise.resolve();
  if (jessibucaLoader) return jessibucaLoader;
  jessibucaLoader = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = scriptUrl;
    script.async = true;
    script.onload = () => window.Jessibuca ? resolve() : reject(new Error('Jessibuca loaded but global constructor is missing.'));
    script.onerror = () => reject(new Error(`Failed to load Jessibuca runtime: ${scriptUrl}`));
    document.head.appendChild(script);
  });
  return jessibucaLoader;
}

export class TeslaPlayer {
  readonly events = new PlayerEvents();
  private state = new PlayerStateMachine();
  private stats: PlayerStatsTracker;
  private guard = new NoVideoGuard();
  private jess?: JessibucaInstance;
  private hls?: HlsWebCodecsEngine;
  private h265?: H265WebEngine;
  private controlBar?: ControlBar;
  private activeEngine: 'jessibuca' | 'webcodecs' | 'h265web' | 'none' = 'none';
  private url = '';
  private sourceType: TeslaSourceType = 'unknown';
  private firstFrameStart = 0;
  private firstFrameSeen = false;
  private volume = 1;
  private handlers: Array<{ event: string; handler: (...args: any[]) => void }> = [];
  private reconnectTimer?: number;
  private reconnectAttempts = 0;
  private options: TeslaPlayerOptions;

  constructor(containerOrOptions: HTMLElement | TeslaPlayerOptions, maybeOptions: TeslaPlayerOptions = {}) {
    const supplied = containerOrOptions instanceof HTMLElement
      ? { ...maybeOptions, container: containerOrOptions }
      : containerOrOptions;
    this.options = normalizePlayerOptions(supplied);
    if (!this.options.container) throw new Error('createTeslaPlayer requires a container element.');
    this.options.container.style.position ||= 'relative';
    this.options.container.style.background ||= '#000';
    this.stats = new PlayerStatsTracker(this.options.container);
    this.volume = this.options.volume ?? 1;
    this.guard.start(count => this.fail(new Error(`video elements are forbidden, found ${count}.`)), this.options.container);
    this.syncControls();
    if (this.options.url) {
      this.load(this.options.url, this.options);
      if (this.options.autoplay) {
        queueMicrotask(() => this.play().catch(error => this.handlePlaybackError(normalizeError(error))));
      }
    }
  }

  on = this.events.on.bind(this.events);
  off = this.events.off.bind(this.events);

  load(url: string, options: TeslaLoadOptions = {}): void {
    if (this.state.current === 'destroyed') throw new Error('Cannot load media after destroy().');
    this.url = url;
    this.options = normalizePlayerOptions({ ...this.options, ...options, container: this.options.container });
    this.sourceType = options.sourceType || inferSourceType(url);
    this.volume = this.options.volume ?? this.volume;
    this.stats.resetSession({ sourceType: this.sourceType, lastError: '' });
    this.applyWebCodecsOptions();
    this.jess?.setVolume(this.volume);
    this.hls?.setVolume(this.volume);
    this.h265?.setVolume(this.volume);
    this.syncControls();
  }

  async play(url?: string, options: TeslaLoadOptions = {}): Promise<void> {
    if (url) this.load(url, options);
    if (!this.url) throw new Error('Playback URL is required.');
    if (this.state.current === 'destroyed') throw new Error('Cannot play media after destroy().');
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    await this.playCurrent(false);
  }

  pause(): void {
    if (this.activeEngine === 'webcodecs') this.hls?.pause();
    else if (this.activeEngine === 'h265web') this.h265?.pause();
    else if (this.activeEngine === 'jessibuca') this.jess?.pause().catch(error => this.handlePlaybackError(normalizeError(error)));
    else return;
    this.state.transition('paused');
    this.events.emit('state', this.state.current);
  }

  async resume(): Promise<void> {
    if (this.activeEngine === 'webcodecs') await this.hls?.resume();
    else if (this.activeEngine === 'h265web') await this.h265?.play(this.url);
    else if (this.activeEngine === 'jessibuca') await this.jess?.play();
  }

  stop(): void {
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    this.stopActiveEngine();
    this.activeEngine = 'none';
    this.state.transition('stopped');
    this.events.emit('state', this.state.current);
  }

  destroy(): void {
    if (this.state.current === 'destroyed') return;
    this.clearReconnectTimer();
    this.destroyJessibuca();
    this.hls?.destroy();
    this.h265?.destroy();
    this.hls = undefined;
    this.h265 = undefined;
    this.controlBar?.destroy();
    this.controlBar = undefined;
    this.activeEngine = 'none';
    this.guard.stop();
    this.state.transition('destroyed');
    this.events.clear();
  }

  seek(time: number): void {
    if (this.activeEngine === 'webcodecs' && (this.sourceType === 'mp4' || this.sourceType === 'hls')) {
      this.hls?.seek(time).catch(error => this.handlePlaybackError(normalizeError(error)));
      return;
    }
    this.fail(new Error(`seek() is only supported for MP4/HLS on-demand playback; current source is ${this.sourceType}.`));
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, Number(volume) || 0));
    this.options.volume = this.volume;
    this.jess?.setVolume(this.volume);
    this.hls?.setVolume(this.volume);
    this.h265?.setVolume(this.volume);
  }

  setPlaybackRate(rate: number): void {
    this.events.emit('log', `Playback-rate control is not supported by the selected ${this.activeEngine} engine; requested ${rate}.`);
  }

  screenshot(): string {
    if (this.activeEngine === 'webcodecs') {
      const canvas = this.options.container!.querySelector('canvas');
      return canvas ? canvas.toDataURL('image/png') : '';
    }
    const result = this.jess?.screenshot('tesla-frame', 'png', 1, 'base64');
    return typeof result === 'string' ? result : '';
  }

  fullscreen(): void {
    const target = this.options.container!;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    else target.requestFullscreen?.().catch(() => undefined);
  }

  getStats(): TeslaPlayerStats {
    const outer = this.stats.snapshot();
    if (this.activeEngine === 'webcodecs' && this.hls) {
      const engine = this.hls.getStats();
      return {
        ...engine,
        sourceType: this.sourceType,
        reconnectCount: outer.reconnectCount,
        lastError: outer.lastError || engine.lastError
      };
    }
    return outer;
  }

  getState(): string {
    return this.state.current;
  }

  private async playCurrent(isReconnect: boolean): Promise<void> {
    const route = resolveEngineRoute(this.sourceType, this.options.decoderMode, !!this.options.enableH265Web);
    if (!isReconnect) {
      this.stats.resetSession({
        sourceType: this.sourceType,
        decoderType: route === 'webcodecs' ? 'webcodecs' : route === 'jessibuca' || route === 'h265web' ? 'wasm' : 'none',
        rendererType: route === 'webcodecs'
          ? (this.options.renderer === 'canvas' ? 'canvas2d' : 'webgl')
          : route === 'jessibuca' || route === 'h265web' ? 'canvas2d' : 'none',
        audioType: 'webaudio'
      });
    }

    if (route === 'webcodecs') {
      await this.playWithWebCodecsEngine();
      return;
    }
    if (route === 'jessibuca') {
      await this.playWithJessibuca();
      return;
    }
    if (route === 'h265web') {
      await this.playWithH265WebEngine();
      return;
    }
    if ((this.sourceType === 'hls' || this.sourceType === 'mp4') && this.options.decoderMode === 'wasm') {
      throw new Error('decoderMode="wasm" is not available for MP4/HLS because the typed WASM bridge is not implemented. Use decoderMode="auto" or "webcodecs".');
    }
    if (this.sourceType === 'h265') {
      throw new Error('H.265 experimental playback requires enableH265Web and supplied h265web.js runtime/wasm assets.');
    }
    throw new Error(`Unsupported or unrecognized media source: ${this.url}`);
  }

  private async playWithJessibuca(): Promise<void> {
    this.hls?.destroy();
    this.hls = undefined;
    this.h265?.destroy();
    this.h265 = undefined;
    this.destroyJessibuca();
    await loadJessibuca(this.options.jessibucaUrl || new URL('./jessibuca.js', import.meta.url).href);
    const Jessibuca = window.Jessibuca;
    if (!Jessibuca) throw new Error('Jessibuca constructor is not available.');
    this.options.container!.innerHTML = '';
    const reconnect = this.options.reconnect !== false;
    const retries = this.options.reconnectMaxRetries ?? 3;
    this.jess = new Jessibuca({
      container: this.options.container,
      decoder: this.options.decoderUrl || new URL('./decoder.js', import.meta.url).href,
      videoBuffer: this.options.videoBuffer ?? 0.2,
      isResize: this.options.fitMode !== 'fill',
      isFullResize: this.options.fitMode === 'cover',
      hasAudio: true,
      isNotMute: this.volume > 0,
      useMSE: false,
      useWCS: false,
      autoWasm: true,
      debug: !!this.options.debug,
      loadingText: this.options.loadingText || 'loading',
      showBandwidth: true,
      operateBtns: this.options.controls ? {
        fullscreen: true,
        screenshot: true,
        play: true,
        audio: true,
        record: false
      } : {
        fullscreen: false,
        screenshot: false,
        play: false,
        audio: false,
        record: false
      },
      // TeslaPlayer owns the retry timer so all engines follow the same policy.
      heartTimeoutReplay: false,
      heartTimeoutReplayTimes: retries,
      loadingTimeoutReplay: false,
      loadingTimeoutReplayTimes: retries,
      wasmDecodeErrorReplay: false
    });
    this.bindJessibucaEvents(this.jess);
    this.jess.setVolume(this.volume);
    this.activeEngine = 'jessibuca';
    this.firstFrameStart = performance.now();
    this.firstFrameSeen = false;
    this.state.transition('loading');
    this.events.emit('state', this.state.current);
    this.syncControls();
    await this.jess.play(this.url);
  }

  private async playWithWebCodecsEngine(): Promise<void> {
    this.destroyJessibuca();
    this.h265?.destroy();
    this.h265 = undefined;
    if (!this.hls) {
      this.options.container!.innerHTML = '';
      this.hls = new HlsWebCodecsEngine(this.webCodecsOptions());
      this.bindHlsEvents(this.hls);
    } else {
      this.applyWebCodecsOptions();
    }
    this.hls.setVolume(this.volume);
    this.activeEngine = 'webcodecs';
    this.syncControls();
    await this.hls.play(this.url, this.sourceType as 'hls' | 'mp4' | 'http-flv' | 'ws-flv');
  }

  private async playWithH265WebEngine(): Promise<void> {
    this.destroyJessibuca();
    this.hls?.destroy();
    this.hls = undefined;
    if (!this.h265) this.h265 = new H265WebEngine(this.options.container!, this.options);
    this.activeEngine = 'h265web';
    this.state.transition('loading');
    this.events.emit('state', this.state.current);
    this.syncControls();
    try {
      await this.h265.play(this.url);
      this.markPlaying();
    } catch (error: any) {
      this.handlePlaybackError(normalizeError(error));
    }
  }

  private webCodecsOptions(): HlsWebCodecsEngineOptions {
    return {
      container: this.options.container!,
      renderer: this.options.renderer === 'canvas' ? 'canvas2d' : 'webgl',
      workerUrl: this.options.workerUrl,
      fitMode: this.options.fitMode,
      preset: this.options.preset,
      liveStartSegmentCount: this.options.liveStartSegmentCount ?? 3,
      liveSegmentBatch: this.options.liveSegmentBatch ?? 2,
      audioMaxQueueMs: this.options.audioMaxQueueMs ?? 1200,
      decodeBatchSize: this.options.decodeBatchSize,
      maxRenderQueue: this.options.maxRenderQueue,
      lateDropMs: this.options.lateDropMs
    };
  }

  private applyWebCodecsOptions(): void {
    if (!this.hls) return;
    const values = this.webCodecsOptions();
    this.hls.updateSettings(values);
    this.hls.setRenderer(values.renderer || 'webgl');
  }

  private syncControls(): void {
    if (!this.options.controls) {
      this.controlBar?.destroy();
      this.controlBar = undefined;
      return;
    }
    if (!this.controlBar || !this.controlBar.element.isConnected) {
      this.controlBar?.destroy();
      this.controlBar = new ControlBar(this);
      this.options.container!.appendChild(this.controlBar.element);
    }
  }

  private bindHlsEvents(engine: HlsWebCodecsEngine): void {
    engine.events.on('state', state => {
      this.state.transition(state as any);
      this.events.emit('state', this.state.current);
    });
    engine.events.on('error', error => this.handlePlaybackError(error));
    engine.events.on('log', message => this.events.emit('log', message));
    engine.events.on('firstFrame', ms => {
      this.reconnectAttempts = 0;
      this.stats.patch({ firstFrameTimeMs: ms, lastError: '' });
      this.events.emit('firstFrame', ms);
    });
  }

  private bindJessibucaEvents(jess: JessibucaInstance): void {
    const bind = (event: string, handler: (...args: any[]) => void) => {
      jess.on(event, handler);
      this.handlers.push({ event, handler });
    };
    bind('load', () => this.events.emit('log', 'Jessibuca loaded.'));
    bind('start', () => this.markPlaying());
    bind('play', () => this.markPlaying());
    bind('error', (error: any) => this.handlePlaybackError(new Error(typeof error === 'string' ? error : JSON.stringify(error))));
    bind('timeout', (payload: any) => this.handlePlaybackError(new Error(`Jessibuca timeout: ${JSON.stringify(payload)}`)));
    bind('videoInfo', (info: any) => this.events.emit('log', `Video ${info?.encType || ''} ${info?.width || 0}x${info?.height || 0}`));
    bind('audioInfo', (info: any) => this.events.emit('log', `Audio ${info?.encType || ''} ${info?.sampleRate || 0}Hz/${info?.channels || 0}ch`));
    bind('stats', (payload: any) => {
      const stats = typeof payload === 'string' ? safeJson(payload) : payload || {};
      this.stats.patch({
        fps: Number(stats.fps) || 0,
        audioQueueMs: Number(stats.buf) || 0,
        currentTime: Number(stats.ts) ? Number(stats.ts) / 1000 : 0,
        currentTimeMs: Number(stats.ts) || 0,
        bitrate: Math.round(((Number(stats.abps) || 0) + (Number(stats.vbps) || 0)) / 1000)
      });
      this.events.emit('stats', this.getStats());
    });
    bind('kBps', (value: any) => {
      const kbps = Number(value);
      if (Number.isFinite(kbps)) this.stats.patch({ bitrate: Math.round(kbps * 8) });
    });
  }

  private markPlaying(): void {
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    this.stats.patch({ lastError: '' });
    if (!this.firstFrameSeen) {
      this.firstFrameSeen = true;
      const firstFrameTimeMs = Math.round(performance.now() - this.firstFrameStart);
      this.stats.patch({ firstFrameTimeMs });
      this.events.emit('firstFrame', firstFrameTimeMs);
    }
    this.state.transition('playing');
    this.events.emit('state', this.state.current);
  }

  private handlePlaybackError(error: Error): void {
    if (this.state.current === 'destroyed' || this.reconnectTimer !== undefined) return;
    const canReconnect = this.options.reconnect !== false
      && (this.sourceType === 'http-flv' || this.sourceType === 'ws-flv' || this.sourceType === 'hls')
      && this.reconnectAttempts < (this.options.reconnectMaxRetries ?? 3);
    if (!canReconnect) {
      this.fail(error);
      return;
    }

    this.stopActiveEngine();
    this.activeEngine = 'none';
    this.reconnectAttempts += 1;
    this.stats.incrementReconnect();
    this.stats.patch({ lastError: error.message });
    this.events.emit('reconnect', this.reconnectAttempts);
    this.state.transition('loading');
    this.events.emit('state', this.state.current);
    const delay = (this.options.reconnectDelayMs ?? 1000) * this.reconnectAttempts;
    this.clearReconnectTimer();
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.playCurrent(true).catch(next => this.handlePlaybackError(normalizeError(next)));
    }, delay);
  }

  private stopActiveEngine(): void {
    if (this.activeEngine === 'webcodecs') this.hls?.stop();
    else if (this.activeEngine === 'h265web') this.h265?.stop();
    else if (this.activeEngine === 'jessibuca') this.jess?.close();
  }

  private destroyJessibuca(): void {
    if (!this.jess) return;
    for (const { event, handler } of this.handlers) this.jess.off?.(event, handler);
    this.handlers = [];
    try { this.jess.destroy(); } catch {}
    this.jess = undefined;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private fail(error: Error): void {
    if (this.state.current === 'destroyed') return;
    this.clearReconnectTimer();
    this.stopActiveEngine();
    this.activeEngine = 'none';
    this.state.transition('error');
    this.stats.patch({ lastError: error.message });
    this.events.emit('state', this.state.current);
    this.events.emit('error', error);
  }
}

function safeJson(text: string): any {
  try { return JSON.parse(text); } catch { return {}; }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function createTeslaPlayer(container: HTMLElement, options: TeslaPlayerOptions = {}): TeslaPlayer {
  return new TeslaPlayer(container, options);
}

export { TeslaPlayer as TeslaStandalonePlayer };
