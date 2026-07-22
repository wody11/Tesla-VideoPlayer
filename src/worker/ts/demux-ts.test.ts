import {
  decodePesTimestamp,
  demuxTS
} from './demux-ts';
import { decodePcrTimestampUs, estimateVideoFrameDurationUs } from './timing';

describe('demuxTS', () => {
  it('ignores packets without a valid TS payload map', () => {
    const fakeTS = new Uint8Array(188 * 3);
    for (let offset = 0; offset < fakeTS.length; offset += 188) fakeTS[offset] = 0x47;
    expect(demuxTS(fakeTS.buffer)).toEqual([]);
  });
});

describe('MPEG clock decoding', () => {
  it('preserves PTS values above the signed 32-bit range', () => {
    const pts = 5_000_000_000;
    const encoded = new Uint8Array([
      0x20 | (Math.floor(pts / 536870912) & 0x0e) | 1,
      Math.floor(pts / 4194304) & 0xff,
      (Math.floor(pts / 16384) & 0xfe) | 1,
      Math.floor(pts / 128) & 0xff,
      ((pts % 128) << 1) | 1
    ]);
    expect(decodePesTimestamp(encoded, 0)).toBe(pts);
  });

  it('decodes PCR without signed 32-bit overflow', () => {
    const maxBase = 0x1ffffffff;
    const extension = 299;
    const encoded = new Uint8Array([
      Math.floor(maxBase / 33_554_432) & 0xff,
      Math.floor(maxBase / 131_072) & 0xff,
      Math.floor(maxBase / 512) & 0xff,
      Math.floor(maxBase / 2) & 0xff,
      ((maxBase & 1) << 7) | 0x7e | ((extension >> 8) & 1),
      extension & 0xff
    ]);
    expect(decodePcrTimestampUs(encoded, 0)).toBe(Math.round((maxBase * 300 + extension) / 27));
  });
});

describe('video access-unit timing', () => {
  it('derives a monotonic duration for multiple access units in one PES', () => {
    expect(estimateVideoFrameDurationUs(1_000_000, 1_080_000, 2)).toBe(40_000);
    expect(estimateVideoFrameDurationUs(undefined, 1_000_000, 1)).toBe(33_333);
    expect(estimateVideoFrameDurationUs(1_000_000, 5_000_000, 1, 40_000)).toBe(40_000);
  });
});
