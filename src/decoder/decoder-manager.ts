/*
 * Tesla decoder manager. It follows Jessibuca's explicit decoder abstraction,
 * while keeping WebCodecs as the primary no-video path.
 */

import { WebCodecsDecoder, WebCodecsDecoderSink } from './webcodecs-decoder';
import { WasmDecoder } from './wasm-decoder';
import { chooseDecoder } from './decoder-fallback';
import type { TeslaDecodeMode } from '../player/player-options';

export class DecoderManager {
  readonly type: 'webcodecs' | 'wasm';
  private webcodecs?: WebCodecsDecoder;
  private wasm?: WasmDecoder;

  constructor(mode: TeslaDecodeMode, private sink: WebCodecsDecoderSink) {
    this.type = chooseDecoder(mode);
    if (this.type === 'webcodecs') this.webcodecs = new WebCodecsDecoder(sink);
    else this.wasm = new WasmDecoder();
  }

  async configureVideo(config: { codec: string; description?: ArrayBuffer; annexb?: boolean }): Promise<void> {
    if (this.webcodecs) return this.webcodecs.configureVideo(config);
    await this.wasm?.load();
  }

  async configureAudio(config: { codec: string; description: ArrayBuffer; sampleRate: number; numberOfChannels: number }): Promise<void> {
    if (this.webcodecs) return this.webcodecs.configureAudio(config);
    await this.wasm?.load();
  }

  decodeVideo(sample: { data: ArrayBuffer; timestamp: number; duration?: number; key: boolean }): void {
    this.webcodecs?.decodeVideo(sample);
  }

  decodeAudio(sample: { data: ArrayBuffer; timestamp: number; duration?: number }): void {
    this.webcodecs?.decodeAudio(sample);
  }

  close(): void {
    this.webcodecs?.close();
    this.wasm?.close();
  }
}

