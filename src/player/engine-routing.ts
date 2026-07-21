import type { TeslaDecodeMode, TeslaSourceType } from './player-options';

export type TeslaEngineRoute = 'webcodecs' | 'jessibuca' | 'h265web' | 'unsupported';

export function resolveEngineRoute(
  sourceType: TeslaSourceType,
  decoderMode: TeslaDecodeMode = 'auto',
  enableH265Web = false
): TeslaEngineRoute {
  if (sourceType === 'h265') return enableH265Web ? 'h265web' : 'unsupported';
  if (sourceType === 'hls' || sourceType === 'mp4') {
    return decoderMode === 'wasm' ? 'unsupported' : 'webcodecs';
  }
  if (sourceType === 'http-flv' || sourceType === 'ws-flv') {
    return decoderMode === 'webcodecs' ? 'webcodecs' : 'jessibuca';
  }
  return 'unsupported';
}
