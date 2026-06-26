// Browser capability probing for the no-video, WebCodecs-first playback path.
export interface PlayerCapability {
  webCodecsVideo: boolean;
  webCodecsAudio: boolean;
  webAudio: boolean;
  webGL: boolean;
  supported: boolean;
  reason?: string;
}

export function detectCapability(canvas?: HTMLCanvasElement): PlayerCapability {
  const webCodecsVideo = typeof (globalThis as any).VideoDecoder === 'function';
  const webCodecsAudio = typeof (globalThis as any).AudioDecoder === 'function';
  const webAudio = typeof (globalThis as any).AudioContext === 'function' || typeof (globalThis as any).webkitAudioContext === 'function';
  let webGL = false;

  try {
    const probe = canvas || document.createElement('canvas');
    webGL = !!(probe.getContext('webgl') || probe.getContext('experimental-webgl'));
  } catch {
    webGL = false;
  }

  const supported = webCodecsVideo && webCodecsAudio && webAudio;
  const reason = supported ? undefined : 'This browser must support WebCodecs VideoDecoder, WebCodecs AudioDecoder, and WebAudio.';
  return { webCodecsVideo, webCodecsAudio, webAudio, webGL, supported, reason };
}
