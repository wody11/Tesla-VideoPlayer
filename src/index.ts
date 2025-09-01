import { PlayerCore } from './core/player-core';

// Tiny bootstrap (for dev)
(window as any).createPlayer = function(opts: any) {
  const canvas = document.querySelector('canvas') as HTMLCanvasElement;
  return new PlayerCore({ canvas });
};
