import { parseM3U8 } from './playlist';

describe('HLS SAMPLE-AES detection', () => {
  it('parses SAMPLE-AES key method', () => {
    const m3u8 = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://k"\n#EXTINF:4.0,\nseg0.ts\n#EXT-X-ENDLIST\n`;
    const pl = parseM3U8(m3u8, 'http://x/playlist.m3u8');
    expect(pl.key?.method).toBe('SAMPLE-AES');
  });
});
