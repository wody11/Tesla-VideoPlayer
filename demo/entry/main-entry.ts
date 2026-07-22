import { TeslaPlayer, TeslaStandalonePlayer, createTeslaPlayer } from '../../src/index';

if (typeof window !== 'undefined') {
  (window as any).TeslaPlayer = TeslaPlayer;
  (window as any).TeslaStandalonePlayer = TeslaStandalonePlayer;
  (window as any).createTeslaPlayer = createTeslaPlayer;
}

export { TeslaPlayer, TeslaStandalonePlayer, createTeslaPlayer };
export default TeslaPlayer;
