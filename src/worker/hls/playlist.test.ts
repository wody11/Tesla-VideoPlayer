// 单元测试：parseM3U8
import { parseM3U8 } from './playlist';

describe('parseM3U8', () => {
  it('should parse m3u8 and return segment list', () => {
    const m3u8 = '#EXTM3U\n#EXTINF:10.0,\nseg1.ts\n#EXTINF:8.0,\nseg2.ts';
    const parsed = parseM3U8(m3u8, 'http://example.com/');
    expect(Array.isArray(parsed.segments)).toBe(true);
    // TODO: 补充更详细断言
  });
});
