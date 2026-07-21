import { resolveEngineRoute } from './engine-routing';

describe('resolveEngineRoute', () => {
  it('uses WebCodecs for HLS and MP4 unless unsupported WASM is explicitly requested', () => {
    expect(resolveEngineRoute('hls', 'auto')).toBe('webcodecs');
    expect(resolveEngineRoute('mp4', 'webcodecs')).toBe('webcodecs');
    expect(resolveEngineRoute('hls', 'wasm')).toBe('unsupported');
  });

  it('allows decoderMode to select the FLV engine', () => {
    expect(resolveEngineRoute('http-flv', 'auto')).toBe('jessibuca');
    expect(resolveEngineRoute('ws-flv', 'wasm')).toBe('jessibuca');
    expect(resolveEngineRoute('http-flv', 'webcodecs')).toBe('webcodecs');
  });

  it('keeps h265web opt-in', () => {
    expect(resolveEngineRoute('h265', 'auto', false)).toBe('unsupported');
    expect(resolveEngineRoute('h265', 'auto', true)).toBe('h265web');
  });
});
