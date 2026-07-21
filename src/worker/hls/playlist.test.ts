// 单元测试：parseM3U8
import { parseM3U8 } from './playlist';

describe('parseM3U8', () => {
  it('should parse m3u8 and return segment list', () => {
    const m3u8 = '#EXTM3U\n#EXTINF:10.0,\nseg1.ts\n#EXTINF:8.0,\nseg2.ts';
    const parsed = parseM3U8(m3u8, 'http://example.com/');
    expect(parsed.segments.map(segment => segment.uri)).toEqual([
      'http://example.com/seg1.ts',
      'http://example.com/seg2.ts'
    ]);
    expect(parsed.segments.map(segment => segment.duration)).toEqual([10, 8]);
  });

  it('keeps the active AES-128 key on each segment and resolves key URLs', () => {
    const parsed = parseM3U8(`#EXTM3U
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin"
#EXTINF:4,
one.ts
#EXT-X-KEY:METHOD=NONE
#EXTINF:4,
two.ts
#EXT-X-ENDLIST`, 'https://media.example/live/index.m3u8');

    expect(parsed.segments[0].seq).toBe(7);
    expect(parsed.segments[0].key).toEqual({
      method: 'AES-128',
      uri: 'https://media.example/live/keys/key.bin',
      ivHex: undefined
    });
    expect(parsed.segments[1].key?.method).toBe('NONE');
  });

  it('marks only the segment following EXT-X-DISCONTINUITY', () => {
    const parsed = parseM3U8(`#EXTM3U
#EXT-X-MEDIA-SEQUENCE:10
#EXTINF:4,
one.ts
#EXT-X-DISCONTINUITY
#EXTINF:4,
two.ts
#EXTINF:4,
three.ts`, 'https://media.example/live/index.m3u8');

    expect(parsed.segments.map(segment => segment.discontinuity)).toEqual([undefined, true, undefined]);
  });

});
