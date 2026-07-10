/*
 * AudioWorklet is not required for the current WebAudio scheduling path.
 * TODO: move PCM scheduling into an AudioWorklet for lower jitter on browsers
 * that throttle main-thread timers.
 */

export const audioWorkletStatus = {
  enabled: false,
  reason: 'AudioWorklet scheduling is TODO; WebAudio buffer scheduling is active.'
};

