import { TeslaStandalonePlayer } from './core/tesla-standalone-player';

export { TeslaStandalonePlayer } from './core/tesla-standalone-player';

(window as any).TeslaStandalonePlayer = TeslaStandalonePlayer;
(window as any).createTeslaPlayer = function(opts: any) {
  return new TeslaStandalonePlayer(opts);
};
