/*
 * Decoder selection policy: WebCodecs first, WASM fallback when explicitly
 * requested or when WebCodecs is unavailable.
 */

import { detectCapability } from '../utils/capability';
import type { TeslaDecodeMode } from '../player/player-options';

export function chooseDecoder(mode: TeslaDecodeMode): 'webcodecs' | 'wasm' {
  const capability = detectCapability(undefined, false);
  if (mode === 'webcodecs') return 'webcodecs';
  if (mode === 'wasm') return 'wasm';
  return capability.webCodecsVideo && capability.webCodecsAudio ? 'webcodecs' : 'wasm';
}

