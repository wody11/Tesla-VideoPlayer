import { PlayerCore } from '../../src/core/player-core';

// expose to window for demo page
(window as any).PlayerCore = PlayerCore;
try { if ((window as any).__DEMO_DEBUG) console.info('demo entry: PlayerCore exposed to window'); } catch {}

export default PlayerCore;
