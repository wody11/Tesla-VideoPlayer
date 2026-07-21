import { normalizePlayerOptions } from './player-options';

describe('normalizePlayerOptions', () => {
  it('applies public defaults and clamps numeric options', () => {
    const options = normalizePlayerOptions({ volume: 5, reconnectMaxRetries: -2, reconnectDelayMs: 1 });
    expect(options).toMatchObject({
      decoderMode: 'auto',
      renderer: 'webgl',
      fitMode: 'contain',
      controls: false,
      autoplay: false,
      preset: 'balanced',
      volume: 1,
      reconnect: true,
      reconnectMaxRetries: 0,
      reconnectDelayMs: 100
    });
  });
});
