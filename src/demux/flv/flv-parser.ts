/*
 * Tesla FLV parser. Inspired by Jessibuca's demux/flvLoader.js but written
 * for the no-video WebCodecs pipeline.
 * Jessibuca is licensed under GPL-3.0. See THIRD_PARTY_NOTICES.md.
 */

import { avcCodecFromBytes, parseAacConfig } from '../common/codec-config';

export type FlvParserEvent =
  | { type: 'video-config'; codec: string; description?: ArrayBuffer; annexb?: boolean }
  | { type: 'audio-config'; codec: string; description: ArrayBuffer; sampleRate: number; numberOfChannels: number }
  | { type: 'video-sample'; timestamp: number; duration?: number; key: boolean; data: ArrayBuffer }
  | { type: 'audio-sample'; timestamp: number; duration?: number; data: ArrayBuffer }
  | { type: 'error'; message: string };

function readU24(u8: Uint8Array, offset: number): number {
  return (u8[offset] << 16) | (u8[offset + 1] << 8) | u8[offset + 2];
}

function readS24(u8: Uint8Array, offset: number): number {
  const value = readU24(u8, offset);
  return value & 0x800000 ? value - 0x1000000 : value;
}

export class FlvParser {
  private buffer = new Uint8Array(0);
  private headerDone = false;

  constructor(private emit: (event: FlvParserEvent) => void) {}

  push(chunk: Uint8Array): void {
    const next = new Uint8Array(this.buffer.length + chunk.length);
    next.set(this.buffer, 0);
    next.set(chunk, this.buffer.length);
    this.buffer = next;
    this.parse();
  }

  private parse(): void {
    let offset = 0;
    if (!this.headerDone) {
      if (this.buffer.length < 13) return;
      if (this.buffer[0] !== 0x46 || this.buffer[1] !== 0x4c || this.buffer[2] !== 0x56) {
        this.emit({ type: 'error', message: 'Invalid FLV signature.' });
        this.buffer = new Uint8Array(0);
        return;
      }
      const headerSize = (this.buffer[5] << 24) | (this.buffer[6] << 16) | (this.buffer[7] << 8) | this.buffer[8];
      offset = headerSize + 4;
      this.headerDone = true;
    }

    while (this.buffer.length - offset >= 15) {
      const tagType = this.buffer[offset];
      const dataSize = readU24(this.buffer, offset + 1);
      const timestampMs = readU24(this.buffer, offset + 4) | (this.buffer[offset + 7] << 24);
      const tagStart = offset + 11;
      const tagEnd = tagStart + dataSize;
      const nextOffset = tagEnd + 4;
      if (this.buffer.length < nextOffset) break;
      const payload = this.buffer.subarray(tagStart, tagEnd);
      if (tagType === 9) this.parseVideo(payload, timestampMs);
      else if (tagType === 8) this.parseAudio(payload, timestampMs);
      offset = nextOffset;
    }

    if (offset > 0) this.buffer = this.buffer.slice(offset);
  }

  private parseVideo(payload: Uint8Array, timestampMs: number): void {
    if (payload.length < 5) return;
    const frameType = payload[0] >> 4;
    const codecId = payload[0] & 0x0f;
    if (codecId !== 7) {
      this.emit({ type: 'error', message: `Unsupported FLV video codec ${codecId}; H.265/WASM fallback is TODO in no-video mode.` });
      return;
    }
    const packetType = payload[1];
    const compositionMs = readS24(payload, 2);
    if (packetType === 0) {
      const description = payload.slice(5).buffer;
      this.emit({ type: 'video-config', codec: avcCodecFromBytes(new Uint8Array(description)), description });
      return;
    }
    if (packetType !== 1) return;
    const data = payload.slice(5).buffer;
    this.emit({ type: 'video-sample', timestamp: (timestampMs + compositionMs) * 1000, key: frameType === 1, data });
  }

  private parseAudio(payload: Uint8Array, timestampMs: number): void {
    if (payload.length < 2) return;
    const soundFormat = payload[0] >> 4;
    if (soundFormat !== 10) {
      this.emit({ type: 'error', message: `Unsupported FLV audio codec ${soundFormat}; G711 decode is TODO in no-video WebAudio path.` });
      return;
    }
    const packetType = payload[1];
    if (packetType === 0) {
      const description = payload.slice(2).buffer;
      const info = parseAacConfig(new Uint8Array(description));
      this.emit({ type: 'audio-config', codec: info.codec, description, sampleRate: info.sampleRate, numberOfChannels: info.channels });
      return;
    }
    if (packetType !== 1) return;
    const data = payload.slice(2).buffer;
    this.emit({ type: 'audio-sample', timestamp: timestampMs * 1000, data });
  }
}

