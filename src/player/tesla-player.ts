/*
 * Tesla-VideoPlayer runtime now delegates playback to Jessibuca OSS directly.
 * Jessibuca is licensed under GPL-3.0. See THIRD_PARTY_NOTICES.md.
 */

import { PlayerEvents } from './player-events';
import { PlayerStateMachine } from './player-state';
import { PlayerStatsTracker, TeslaPlayerStats } from './player-stats';
import { inferSourceType, TeslaLoadOptions, TeslaPlayerOptions, TeslaSourceType } from './player-options';
import { NoVideoGuard } from '../utils/no-video-guard';
import { HlsWebCodecsEngine } from './hls-webcodecs-engine';
import { H265WebEngine } from './h265web-engine';

type JessibucaInstance = {
  play(url?: string, options?: any): Promise<void>;
  pause(): Promise<void>;
  close(): void;
  destroy(): void;
  setVolume(volume: number): void;
  screenshot(filename?: string, format?: string, quality?: number, type?: string): any;
  on(event: string, handler: (...args: any[]) => void): void;
  off?: (event: string, handler: (...args: any[]) => void) => void;
  setScaleMode?: (mode: number) => void;
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
  private stats = new PlayerStatsTracker();
  private guard = new NoVideoGuard();
  private jess?: JessibucaInstance;
  private hls?: HlsWebCodecsEngine;
  private h265?: H265WebEngine;
  private activeEngine: 'jessibuca' | 'hls' | 'h265web' | 'none' = 'none';
  private url = '';
  private sourceType: TeslaSourceType = 'unknown';
  private firstFrameStart = 0;
  private firstFrameSeen = false;
  private volume = 1;
  private handlers: Array<{ event: string; handler: (...args: any[]) => void }> = [];

  constructor(private containerOrOptions: HTMLElement | TeslaPlayerOptions, maybeOptions: TeslaPlayerOptions = {}) {
    this.options = containerOrOptions instanceof HTMLElement
      ? { ...maybeOptions, container: containerOrOptions }
      : containerOrOptions;
    if (!this.options.container) throw new Error('createTeslaPlayer requires a container element.');
    this.options.container.style.position ||= 'relative';
    this.options.container.style.background ||= '#000';
    this.guard.start(count => this.fail(new Error(`video elements are forbidden, found ${count}.`)));
    this.stats.patch({
      decoderType: 'wasm',
      rendererType: 'canvas2d',
      audioType: 'webaudio'
    });
    if (this.options.url) this.load(this.options.url, this.options);
  }

  private options: TeslaPlayerOptions;

  on = this.events.on.bind(this.events);
  off = this.events.off.bind(this.events);

  load(url: string, options: TeslaLoadOptions = {}): void {
    this.url = url;
    this.options = { ...this.options, ...options };
    this.sourceType = options.sourceType || inferSourceType(url);
    this.stats.patch({ sourceType: this.sourceType, lastError: '' });
  }

  async play(url?: string, options: TeslaLoadOptions = {}): Promise<void> {
    if (url) this.load(url, options);
    if (!this.url) throw new Error('Playback URL is required.');
    if (this.sourceType === 'hls' || this.sourceType === 'mp4') {
      await this.playWithHlsEngine();
      return;
    }
    if (this.sourceType === 'h265') {
      if (!this.options.enableH265Web) {
        this.fail(new Error('h265web.js is studied but disabled by default for Tesla no-video mode. Set enableH265Web only after supplying its missing runtime/wasm assets.'));
        return;
      }
      await this.playWithH265WebEngine();
      return;
    }
    await this.ensureJessibuca();
    this.firstFrameStart = performance.now();
    this.firstFrameSeen = false;
    this.state.transition('loading');
    this.events.emit('state', this.state.current);
    await this.jess!.play(this.url);
  }

  pause(): void {
    if (this.activeEngine === 'hls') this.hls?.pause();
    else if (this.activeEngine === 'h265web') this.h265?.pause();
    else this.jess?.pause().catch(error => this.fail(error));
    this.state.transition('paused');
    this.events.emit('state', this.state.current);
  }

  async resume(): Promise<void> {
    if (this.activeEngine === 'hls') await this.hls?.resume();
    else if (this.activeEngine === 'h265web') await this.h265?.play(this.url);
    else await this.jess?.play();
  }

  stop(): void {
    if (this.activeEngine === 'hls') this.hls?.stop();
    else if (this.activeEngine === 'h265web') this.h265?.stop();
    else this.jess?.close();
    this.state.transition('stopped');
    this.events.emit('state', this.state.current);
  }

  destroy(): void {
    this.jess?.destroy();
    this.hls?.destroy();
    this.h265?.destroy();
    this.jess = undefined;
    this.hls = undefined;
    this.h265 = undefined;
    this.handlers = [];
    this.guard.stop();
    this.events.clear();
    this.state.transition('destroyed');
  }

  seek(time: number): void {
    if (this.activeEngine === 'hls' && (this.sourceType === 'mp4' || this.sourceType === 'hls')) {
      this.hls?.seek(time).catch(error => this.fail(error instanceof Error ? error : new Error(String(error))));
      return;
    }
    this.fail(new Error(`seek() is only supported for MP4/HLS on-demand playback; current source is ${this.sourceType}.`));
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, Number(volume) || 0));
    this.jess?.setVolume(this.volume);
    this.hls?.setVolume(this.volume);
    this.h265?.setVolume(this.volume);
  }

  setPlaybackRate(rate: number): void {
    this.events.emit('log', `Jessibuca FLV live playbackRate is not exposed; requested ${rate}.`);
  }

  screenshot(): string {
    if (this.activeEngine === 'hls') {
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
    if (this.activeEngine === 'hls' && this.hls) {
      return { ...this.hls.getStats(), sourceType: this.sourceType };
    }
    return this.stats.snapshot();
  }

  getState(): string {
    return this.state.current;
  }

  private async ensureJessibuca(): Promise<void> {
    if (this.jess) return;
    this.hls?.destroy();
    this.hls = undefined;
    this.activeEngine = 'jessibuca';
    await loadJessibuca(this.options.jessibucaUrl || new URL('./jessibuca.js', import.meta.url).href);
    const Jessibuca = window.Jessibuca;
    if (!Jessibuca) throw new Error('Jessibuca constructor is not available.');
    this.options.container!.innerHTML = '';
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
      operateBtns: {
        fullscreen: true,
        screenshot: true,
        play: true,
        audio: true,
        record: false
      },
      heartTimeoutReplay: true,
      heartTimeoutReplayTimes: 3,
      loadingTimeoutReplay: true,
      loadingTimeoutReplayTimes: 3,
      wasmDecodeErrorReplay: true
    });
    this.bindJessibucaEvents(this.jess);
    this.jess.setVolume(this.volume);
  }

  private async playWithHlsEngine(): Promise<void> {
    this.jess?.destroy();
    this.jess = undefined;
    this.h265?.destroy();
    this.h265 = undefined;
    if (!this.hls) {
      this.options.container!.innerHTML = '';
      this.hls = new HlsWebCodecsEngine({
        container: this.options.container!,
        renderer: this.options.renderer === 'canvas' ? 'canvas2d' : 'webgl',
        workerUrl: this.options.workerUrl,
        fitMode: this.options.fitMode,
        liveStartSegmentCount: this.options.liveStartSegmentCount ?? 3,
        liveSegmentBatch: this.options.liveSegmentBatch ?? 2,
        audioMaxQueueMs: this.options.audioMaxQueueMs ?? 1200,
        decodeBatchSize: this.options.decodeBatchSize,
        maxRenderQueue: this.options.maxRenderQueue,
        lateDropMs: this.options.lateDropMs
      });
      this.bindHlsEvents(this.hls);
      this.hls.setVolume(this.volume);
    }
    this.activeEngine = 'hls';
    this.stats.patch({ sourceType: this.sourceType, decoderType: 'webcodecs', rendererType: this.options.renderer === 'canvas' ? 'canvas2d' : 'webgl', audioType: 'webaudio' });
    await this.hls.play(this.url, this.sourceType as 'hls' | 'mp4');
  }

  private async playWithH265WebEngine(): Promise<void> {
    this.jess?.destroy();
    this.jess = undefined;
    this.hls?.destroy();
    this.hls = undefined;
    if (!this.h265) this.h265 = new H265WebEngine(this.options.container!, this.options);
    this.activeEngine = 'h265web';
    this.state.transition('loading');
    this.stats.patch({
      sourceType: 'h265',
      decoderType: 'wasm',
      rendererType: 'canvas2d',
      audioType: 'webaudio',
      lastError: ''
    });
    this.events.emit('state', this.state.current);
    try {
      await this.h265.play(this.url);
      this.state.transition('playing');
      this.events.emit('state', this.state.current);
    } catch (error: any) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private bindHlsEvents(engine: HlsWebCodecsEngine): void {
    engine.events.on('state', state => {
      this.state.transition(state as any);
      this.events.emit('state', this.state.current);
    });
    engine.events.on('error', error => this.fail(error));
    engine.events.on('log', message => this.events.emit('log', message));
    engine.events.on('firstFrame', ms => {
      this.stats.patch({ firstFrameTimeMs: ms });
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
    bind('error', (error: any) => this.fail(new Error(typeof error === 'string' ? error : JSON.stringify(error))));
    bind('timeout', (payload: any) => this.fail(new Error(`Jessibuca timeout: ${JSON.stringify(payload)}`)));
    bind('videoInfo', (info: any) => {
      this.events.emit('log', `Video ${info?.encType || ''} ${info?.width || 0}x${info?.height || 0}`);
    });
    bind('audioInfo', (info: any) => {
      this.events.emit('log', `Audio ${info?.encType || ''} ${info?.sampleRate || 0}Hz/${info?.channels || 0}ch`);
    });
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
    if (!this.firstFrameSeen) {
      this.firstFrameSeen = true;
      const firstFrameTimeMs = Math.round(performance.now() - this.firstFrameStart);
      this.stats.patch({ firstFrameTimeMs });
      this.events.emit('firstFrame', firstFrameTimeMs);
    }
    this.state.transition('playing');
    this.events.emit('state', this.state.current);
  }

  private fail(error: Error): void {
    this.state.transition('error');
    this.stats.patch({ lastError: error.message });
    this.events.emit('state', this.state.current);
    this.events.emit('error', error);
  }
}

function safeJson(text: string): any {
  try { return JSON.parse(text); } catch { return {}; }
}

export function createTeslaPlayer(container: HTMLElement, options: TeslaPlayerOptions = {}): TeslaPlayer {
  return new TeslaPlayer(container, options);
}

export { TeslaPlayer as TeslaStandalonePlayer };
