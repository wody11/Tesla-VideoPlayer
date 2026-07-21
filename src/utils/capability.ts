/*
 * Tesla-VideoPlayer is based on Jessibuca open source architecture.
 * Jessibuca is licensed under GPL-3.0. See THIRD_PARTY_NOTICES.md.
 */

export interface PlayerCapability {
  webCodecsVideo: boolean;
  webCodecsAudio: boolean;
  webAudio: boolean;
  webGL: boolean;
  wasm: boolean;
  supported: boolean;
  reason?: string;
}

export function detectCapability(canvas?: HTMLCanvasElement, requireWebCodecs = true): PlayerCapability {
  const webCodecsVideo = typeof (globalThis as any).VideoDecoder === 'function';
  const webCodecsAudio = typeof (globalThis as any).AudioDecoder === 'function';
  const webAudio = typeof (globalThis as any).AudioContext === 'function' || typeof (globalThis as any).webkitAudioContext === 'function';
  const wasm = typeof WebAssembly !== 'undefined';
  let webGL = false;

  try {
    const probe = canvas || document.createElement('canvas');
    webGL = !!(probe.getContext('webgl') || probe.getContext('experimental-webgl'));
  } catch {
    webGL = false;
  }

  const supported = webAudio && (!requireWebCodecs || (webCodecsVideo && webCodecsAudio));
  const reason = supported ? undefined : 'This playback route requires WebAudio and WebCodecs. Select the Jessibuca engine for supported FLV/WASM playback.';
  return { webCodecsVideo, webCodecsAudio, webAudio, webGL, wasm, supported, reason };
}

