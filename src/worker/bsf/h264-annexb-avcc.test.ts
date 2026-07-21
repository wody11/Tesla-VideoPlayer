import { annexBToAvcc, avccToAnnexB, extractSpsPps } from './h264-annexb-avcc';

describe('h264-annexb-avcc', () => {
  it('converts Annex-B NAL units to and from four-byte AVCC lengths', () => {
    const annexB = new Uint8Array([
      0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1e,
      0, 0, 1, 0x68, 0xce, 0x06
    ]).buffer;
    const avcc = new Uint8Array(annexBToAvcc(annexB));
    expect(Array.from(avcc)).toEqual([
      0, 0, 0, 4, 0x67, 0x42, 0x00, 0x1e,
      0, 0, 0, 3, 0x68, 0xce, 0x06
    ]);
    expect(Array.from(new Uint8Array(avccToAnnexB(avcc)))).toEqual([
      0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1e,
      0, 0, 0, 1, 0x68, 0xce, 0x06
    ]);
  });

  it('extracts SPS and PPS NAL units', () => {
    const annexB = new Uint8Array([
      0, 0, 1, 0x67, 1, 2, 3,
      0, 0, 1, 0x68, 4, 5
    ]).buffer;
    const result = extractSpsPps(annexB);
    expect(Array.from(new Uint8Array(result.sps[0]))).toEqual([0x67, 1, 2, 3]);
    expect(Array.from(new Uint8Array(result.pps[0]))).toEqual([0x68, 4, 5]);
  });
});
