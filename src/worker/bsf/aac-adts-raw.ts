// AAC ADTS -> RAW 解析工具
// 负责解析 ADTS 帧，输出 RAW 数据和 ASC

export function adtsToRaw(buffer: ArrayBuffer): ArrayBuffer[] {
  const u8 = new Uint8Array(buffer);
  const frames = parseADTSFrames(u8);
  return frames.map(f => f.slice().buffer);
}

export function extractASCFromADTSHeader(header: Uint8Array): Uint8Array | null {
  if (header.length < 7) return null;
  // profile: 2 bits (after sync fields), sampling_frequency_index: 4 bits, channel_configuration: 3 bits
  const profile = ((header[2] >> 6) & 0x03) + 1; // 1=Main,2=LC, etc. Add 1 to map to AudioObjectType
  const samplingFreqIndex = (header[2] >> 2) & 0x0f;
  const channelConfig = ((header[2] & 0x01) << 2) | ((header[3] >> 6) & 0x03);
  // Build minimal ASC (AudioSpecificConfig) 2 bytes (may need extension for SBR/PS, omitted here)
  const asc = new Uint8Array(2);
  asc[0] = (profile << 3) | ((samplingFreqIndex >> 1) & 0x07);
  asc[1] = ((samplingFreqIndex & 0x01) << 7) | ((channelConfig & 0x0f) << 3);
  return asc;
}

export function extractASC(buffer: ArrayBuffer): ArrayBuffer {
  const u8 = new Uint8Array(buffer);
  // Try to find first ADTS header and build ASC from it
  for (let o = 0; o + 7 <= u8.length; o++) {
    if (u8[o] === 0xff && (u8[o+1] & 0xf0) === 0xf0) {
  const asc = extractASCFromADTSHeader(u8.subarray(o, o + 7));
  if (asc) return asc.slice().buffer;
      break;
    }
  }
  // fallback: empty buffer
  return new ArrayBuffer(0);
}

export function parseADTSFrames(u8: Uint8Array) {
  const frames: Uint8Array[] = [];
  let o = 0;
  while (o + 7 <= u8.length) {
    if (u8[o] !== 0xff || (u8[o+1] & 0xf0) !== 0xf0) { o++; continue; }
    const hasCrc = ((u8[o+1] & 0x01) === 0);
    const frameLen = ((u8[o+3] & 0x03) << 11) | (u8[o+4] << 3) | ((u8[o+5] >> 5) & 0x07);
    const hdrLen = hasCrc ? 9 : 7;
    if (o + frameLen > u8.length || frameLen <= hdrLen) break;
    frames.push(u8.subarray(o + hdrLen, o + frameLen));
    o += frameLen;
  }
  return frames;
}

export function getAdtsInfo(u8: Uint8Array): { sampleRate: number; channels: number } | null {
  for (let o = 0; o + 7 <= u8.length; o++) {
    if (u8[o] !== 0xff || (u8[o+1] & 0xf0) !== 0xf0) continue;
    const samplingFreqIndex = (u8[o+2] >> 2) & 0x0f;
    const channelConfig = ((u8[o+2] & 0x01) << 2) | ((u8[o+3] >> 6) & 0x03);
    const samplingFrequencies = [96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350];
    const sampleRate = samplingFrequencies[samplingFreqIndex] || 48000;
    return { sampleRate, channels: channelConfig };
  }
  return null;
}
