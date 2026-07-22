import { adtsToRaw, extractASC, getAdtsInfo } from './aac-adts-raw';

function makeAdtsFrame(payload: number[]): Uint8Array {
  const frameLength = 7 + payload.length;
  return new Uint8Array([
    0xff, 0xf1, 0x50,
    0x80 | ((frameLength >> 11) & 0x03),
    (frameLength >> 3) & 0xff,
    ((frameLength & 0x07) << 5) | 0x1f,
    0xfc,
    ...payload
  ]);
}

describe('aac-adts-raw', () => {
  it('extracts raw AAC payload, ASC, sample rate, and channels', () => {
    const frame = makeAdtsFrame([1, 2, 3, 4]);
    const raw = adtsToRaw(frame.buffer);
    expect(raw).toHaveLength(1);
    expect(Array.from(new Uint8Array(raw[0]))).toEqual([1, 2, 3, 4]);
    expect(Array.from(new Uint8Array(extractASC(frame.buffer)))).toEqual([0x12, 0x10]);
    expect(getAdtsInfo(frame)).toEqual({ sampleRate: 44100, channels: 2 });
  });

  it('ignores truncated ADTS frames', () => {
    const frame = makeAdtsFrame([1, 2, 3, 4]).slice(0, 9);
    expect(adtsToRaw(frame.buffer)).toEqual([]);
  });
});
