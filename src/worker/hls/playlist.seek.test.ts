import { timeToSeq, parseM3U8 } from './playlist';

describe('HLS timeToSeq', () => {
  const sample = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:3.0,\nseg100.ts\n#EXTINF:3.5,\nseg101.ts\n#EXTINF:4.0,\nseg102.ts\n#EXT-X-ENDLIST\n`;

  it('maps ms to correct seq within VOD window', () => {
    const pl = parseM3U8(sample, 'http://x/playlist.m3u8');
    expect(pl.endList).toBe(true);
    // 0ms -> first seq
    expect(timeToSeq(pl.segments, pl.mediaSequence, 0)).toBe(100);
    // 2900ms -> still seq100
    expect(timeToSeq(pl.segments, pl.mediaSequence, 2900)).toBe(100);
    // 3000ms -> seq101
    expect(timeToSeq(pl.segments, pl.mediaSequence, 3000)).toBe(101);
    // 6499ms -> seq101
    expect(timeToSeq(pl.segments, pl.mediaSequence, 6499)).toBe(101);
    // 6500ms -> seq102
    expect(timeToSeq(pl.segments, pl.mediaSequence, 6500)).toBe(102);
    // beyond total -> last seq
    expect(timeToSeq(pl.segments, pl.mediaSequence, 999999)).toBe(102);
  });
});
