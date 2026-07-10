/*
 * Codec helpers for WebCodecs/WASM selection.
 */

export function isHevcCodec(codec: string): boolean {
  return /^hvc1|^hev1/i.test(codec) || /h265|hevc/i.test(codec);
}

export function isAvcCodec(codec: string): boolean {
  return /^avc1|h264/i.test(codec);
}

export function isAacCodec(codec: string): boolean {
  return /^mp4a/i.test(codec) || /aac/i.test(codec);
}

