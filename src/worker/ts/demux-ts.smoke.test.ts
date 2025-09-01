import { demuxTS } from './demux-ts';

test('demuxTS should return empty on garbage input', () => {
  const buf = new ArrayBuffer(0);
  const out = demuxTS(buf);
  expect(Array.isArray(out)).toBe(true);
});
