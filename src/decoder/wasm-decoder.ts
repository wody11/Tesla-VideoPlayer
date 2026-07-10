/*
 * Tesla WASM decoder fallback hook.
 *
 * Jessibuca ships GPL-3.0 decoder.js/decoder.wasm assets. This project records
 * that provenance in THIRD_PARTY_NOTICES.md. The no-video player attempts this
 * path when requested, but a full typed bridge for H.265/G711 frame output is
 * still TODO and will throw a clear runtime error instead of pretending success.
 */

export class WasmDecoder {
  readonly type = 'wasm' as const;

  async load(): Promise<void> {
    throw new Error('WASM decoder fallback is detected but not fully integrated yet. TODO: bridge Jessibuca decoder.js/decoder.wasm to Tesla frame/audio queues.');
  }

  close(): void {
    // TODO: close Jessibuca WASM decoder worker/heap after bridge is implemented.
  }
}

