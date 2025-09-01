import { parseM3U8 } from './playlist';

test('parseM3U8 handles empty playlist', () => {
  const txt = '#EXTM3U\n#EXT-X-VERSION:3\n';
  const out = parseM3U8(txt, 'http://example.com/list.m3u8');
  expect(out).toBeTruthy();
});
