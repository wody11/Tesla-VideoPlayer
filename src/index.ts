/*
 * Tesla-VideoPlayer public entry.
 * Based on Jessibuca open source architecture and distributed under GPL-3.0.
 */

export { TeslaPlayer, TeslaStandalonePlayer, createTeslaPlayer } from './player/tesla-player';
export type { TeslaPlayerOptions, TeslaLoadOptions, TeslaDecodeMode, TeslaRenderMode, TeslaSourceType } from './player/player-options';
export type { TeslaPlayerStats } from './player/player-stats';
export { decodePesTimestamp, demuxTS } from './worker/ts/demux-ts';

import { TeslaPlayer, createTeslaPlayer } from './player/tesla-player';

if (typeof window !== 'undefined') {
  (window as any).TeslaPlayer = TeslaPlayer;
  (window as any).TeslaStandalonePlayer = TeslaPlayer;
  (window as any).createTeslaPlayer = createTeslaPlayer;
}
