import { serializeConfigurationBox } from './mp4box-demuxer';

describe('serializeConfigurationBox', () => {
  it('returns the decoder configuration payload without the ISO box header', () => {
    const box = {
      write(stream: any) {
        stream.writeUint32(12);
        stream.writeString('avcC');
        stream.writeUint8Array([1, 2, 3, 4]);
      }
    };
    expect(Array.from(new Uint8Array(serializeConfigurationBox(box)!))).toEqual([1, 2, 3, 4]);
  });

  it('returns undefined for an empty configuration box', () => {
    const box = {
      write(stream: any) {
        stream.writeUint32(8);
        stream.writeString('avcC');
      }
    };
    expect(serializeConfigurationBox(box)).toBeUndefined();
  });
});
