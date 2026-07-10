/*
 * h265web.js integration layer.
 *
 * The npm package h265web.js@2.2.2 is vendored under vendor/h265webjs, but its
 * published package does not include the actual dist/h265webjs.js runtime or
 * wasm decoder assets referenced by its README. This engine therefore exposes
 * the integration contract and fails with a clear error until those assets are
 * supplied.
 */

import type { TeslaPlayerOptions } from './player-options';

type H265WebInstance = {
  play(): void;
  pause(): void;
  release?: () => void;
  close?: () => void;
  setVoice?: (volume: number) => void;
  seek?: (time: number) => void;
  mediaInfo?: () => any;
  isPlaying?: () => boolean;
  do?: () => void;
  onRender?: (...args: any[]) => void;
  onLoadFinish?: () => void;
  onPlayTime?: (pts: number) => void;
  onPlayFinish?: () => void;
};

declare global {
  interface Window {
    new265webjs?: (videoURL: string | null, config: any) => H265WebInstance;
  }
}

let h265webLoader: Promise<void> | undefined;

function loadScript(url: string): Promise<void> {
  if (window.new265webjs) return Promise.resolve();
  if (h265webLoader) return h265webLoader;
  h265webLoader = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = () => window.new265webjs ? resolve() : reject(new Error('h265web.js loaded but window.new265webjs is missing.'));
    script.onerror = () => reject(new Error(`Failed to load h265web.js runtime: ${url}. Expected vendored asset dist/h265webjs.js is missing.`));
    document.head.appendChild(script);
  });
  return h265webLoader;
}

export class H265WebEngine {
  private instance?: H265WebInstance;

  constructor(private container: HTMLElement, private options: TeslaPlayerOptions) {}

  async play(url: string): Promise<void> {
    const runtime = this.options.h265webUrl || new URL('./h265webjs.js', import.meta.url).href;
    await loadScript(runtime);
    if (!window.new265webjs) throw new Error('h265web.js runtime is unavailable.');
    this.container.innerHTML = '';
    const id = this.container.id || `tesla-h265-${Math.random().toString(16).slice(2)}`;
    this.container.id = id;
    this.instance = window.new265webjs(url, {
      player: id,
      width: this.container.clientWidth || 960,
      height: this.container.clientHeight || 540,
      token: '',
      extInfo: {}
    });
    this.instance.do?.();
    this.instance.play?.();
  }

  pause(): void { this.instance?.pause?.(); }
  stop(): void { this.instance?.pause?.(); }
  destroy(): void {
    this.instance?.release?.();
    this.instance?.close?.();
    this.instance = undefined;
  }
  setVolume(volume: number): void { this.instance?.setVoice?.(volume); }
  seek(time: number): void { this.instance?.seek?.(time); }
}

