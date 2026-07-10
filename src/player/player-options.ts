/*
 * Tesla-VideoPlayer is based on Jessibuca open source architecture.
 * Jessibuca is licensed under GPL-3.0. See THIRD_PARTY_NOTICES.md.
 */

export type TeslaSourceType = 'http-flv' | 'ws-flv' | 'hls' | 'mp4' | 'h265' | 'unknown';
export type TeslaDecodeMode = 'auto' | 'webcodecs' | 'wasm';
export type TeslaRenderMode = 'canvas' | 'webgl';
export type TeslaFitMode = 'contain' | 'cover' | 'fill';

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
}

export interface TeslaLoadOptions extends Partial<TeslaPlayerOptions> {
  sourceType?: TeslaSourceType;
}

export function inferSourceType(url: string): TeslaSourceType {
  if (/^wss?:\/\//i.test(url) && /\.flv(\?|$)/i.test(url)) return 'ws-flv';
  if (/\.m3u8(\?|$)/i.test(url)) return 'hls';
  if (/\.mp4(\?|$)/i.test(url) || /[?&]mime_type=video_mp4(?:&|$)/i.test(url)) return 'mp4';
  if (/\.flv(\?|$)/i.test(url) || /^https?:\/\//i.test(url)) return 'http-flv';
  return 'unknown';
}
