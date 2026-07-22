/*
 * Tesla-VideoPlayer is based on Jessibuca open source architecture.
 * Jessibuca is licensed under GPL-3.0. See THIRD_PARTY_NOTICES.md.
 */

export type TeslaSourceType = 'http-flv' | 'ws-flv' | 'hls' | 'mp4' | 'h265' | 'unknown';
export type TeslaDecodeMode = 'auto' | 'webcodecs' | 'wasm';
export type TeslaRenderMode = 'canvas' | 'webgl';
export type TeslaFitMode = 'contain' | 'cover' | 'fill';
export type TeslaAspectRatio = number | 'video';

export interface TeslaPlayerOptions {
  container?: HTMLElement;
  url?: string;
  workerUrl?: string;
  jessibucaUrl?: string;
  decoderUrl?: string;
  h265webUrl?: string;
  enableH265Web?: boolean;
  decoderMode?: TeslaDecodeMode;
  renderer?: TeslaRenderMode;
  fitMode?: TeslaFitMode;
  controls?: boolean;
  autoplay?: boolean;
  preset?: 'low-latency' | 'balanced' | 'smooth';
  volume?: number;
  liveStartSegmentCount?: number;
  liveSegmentBatch?: number;
  audioMaxQueueMs?: number;
  decodeBatchSize?: number;
  maxRenderQueue?: number;
  lateDropMs?: number;
  reconnect?: boolean;
  reconnectMaxRetries?: number;
  reconnectDelayMs?: number;
  videoBuffer?: number;
  debug?: boolean;
  loadingText?: string;
  /** Size the player from its available width and cap it to the visual viewport. */
  responsive?: boolean;
  /** Numeric width/height ratio, or 'video' to follow decoded frame dimensions. */
  aspectRatio?: TeslaAspectRatio;
  /** Fraction of the visible viewport height the player may occupy. */
  maxViewportHeightRatio?: number;
}

export interface TeslaLoadOptions extends Partial<TeslaPlayerOptions> {
  sourceType?: TeslaSourceType;
}

export const DEFAULT_PLAYER_OPTIONS: Readonly<Pick<TeslaPlayerOptions,
  'decoderMode' | 'renderer' | 'fitMode' | 'controls' | 'autoplay' | 'preset' | 'volume'
  | 'reconnect' | 'reconnectMaxRetries' | 'reconnectDelayMs' | 'responsive' | 'aspectRatio' | 'maxViewportHeightRatio'>> = {
  decoderMode: 'auto',
  renderer: 'webgl',
  fitMode: 'contain',
  controls: false,
  autoplay: false,
  preset: 'balanced',
  volume: 1,
  reconnect: true,
  reconnectMaxRetries: 3,
  reconnectDelayMs: 1000,
  responsive: true,
  aspectRatio: 'video',
  maxViewportHeightRatio: 1
};

export function normalizePlayerOptions(options: TeslaPlayerOptions): TeslaPlayerOptions {
  return {
    ...DEFAULT_PLAYER_OPTIONS,
    ...options,
    volume: clamp(Number(options.volume ?? DEFAULT_PLAYER_OPTIONS.volume), 0, 1),
    reconnectMaxRetries: Math.max(0, Math.floor(Number(options.reconnectMaxRetries ?? DEFAULT_PLAYER_OPTIONS.reconnectMaxRetries))),
    reconnectDelayMs: Math.max(100, Math.floor(Number(options.reconnectDelayMs ?? DEFAULT_PLAYER_OPTIONS.reconnectDelayMs))),
    responsive: options.responsive !== false,
    aspectRatio: normalizeAspectRatio(options.aspectRatio ?? DEFAULT_PLAYER_OPTIONS.aspectRatio),
    maxViewportHeightRatio: clamp(Number(options.maxViewportHeightRatio ?? DEFAULT_PLAYER_OPTIONS.maxViewportHeightRatio), 0.25, 1)
  };
}

function normalizeAspectRatio(value: TeslaAspectRatio): TeslaAspectRatio {
  if (value === 'video') return value;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 16 / 9;
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
}

export function inferSourceType(url: string): TeslaSourceType {
  if (/^wss?:\/\//i.test(url) && /\.flv(\?|$)/i.test(url)) return 'ws-flv';
  if (/\.m3u8(\?|$)/i.test(url)) return 'hls';
  if (/\.mp4(\?|$)/i.test(url) || /[?&]mime_type=video_mp4(?:&|$)/i.test(url)) return 'mp4';
  if (/\.flv(\?|$)/i.test(url) || /^https?:\/\//i.test(url)) return 'http-flv';
  return 'unknown';
}
