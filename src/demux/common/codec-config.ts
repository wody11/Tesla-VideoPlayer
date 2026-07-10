/*
 * Codec config helpers shared by FLV/HLS/MP4 demuxers.
 */

export function hex(value: number): string {
  return (value & 0xff).toString(16).padStart(2, '0').toUpperCase();
}

export function avcCodecFromBytes(bytes: Uint8Array): string {
  if (bytes.length >= 4) return `avc1.${hex(bytes[1])}${hex(bytes[2])}${hex(bytes[3])}`;
  return 'avc1.42E01E';
}

export function parseAacConfig(asc: Uint8Array): { codec: string; sampleRate: number; channels: number } {
  const sampleRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const objectType = (asc[0] >> 3) & 0x1f;
  const sampleRateIndex = ((asc[0] & 0x07) << 1) | ((asc[1] >> 7) & 0x01);
  const channels = (asc[1] >> 3) & 0x0f;
  return {
    codec: `mp4a.40.${objectType || 2}`,
    sampleRate: sampleRates[sampleRateIndex] || 48000,
    channels: channels || 2
  };
}

