import { AudioClock } from './audio-clock';
import { calculateAudioStartTime, decideAudioTimelineReset, deriveAudioStartupBufferMs } from './audio-scheduling';

export interface WebAudioPlayerOptions {
  maxQueueMs?: number;
  latencyHint?: 'interactive' | 'balanced' | 'playback';
}

// Schedules decoded AudioData through WebAudio without using media elements.
export class WebAudioPlayer {
  readonly clock = new AudioClock();
  private context: AudioContext;
  private gain: GainNode;
  private scheduledUntil = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private maxQueueMs = 1500;
  private startupBufferMs = 180;
  private enqueuedFrames = 0;
  private lastFrameSamples = 0;
  private lastTimestampUs = 0;
  private expectedNextTimestampUs?: number;
  private timelineResetCount = 0;
  private underrunCount = 0;
  private volume = 1;
  private readonly fadeSeconds = 0.012;

  constructor(options: WebAudioPlayerOptions = {}) {
    const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) throw new Error('WebAudio is not available.');
    this.context = new Ctor({ latencyHint: options.latencyHint || 'balanced' });
    this.gain = this.context.createGain();
    this.gain.gain.value = 1;
    this.gain.connect(this.context.destination);
    this.setMaxQueueMs(options.maxQueueMs ?? 1500);
  }

  async resume(): Promise<void> {
    if (this.context.state !== 'running') await this.context.resume();
  }

  pause(): void {
    this.context.suspend().catch(() => undefined);
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, Number(value) || 0));
    const now = this.context.currentTime;
    const param = this.gain.gain;
    this.holdGainAt(now);
    param.linearRampToValueAtTime(this.volume, now + this.fadeSeconds);
  }

  setMaxQueueMs(value: number): void {
    this.maxQueueMs = Math.max(300, Math.min(5000, Number(value) || 1500));
    this.startupBufferMs = deriveAudioStartupBufferMs(this.maxQueueMs);
  }

  enqueue(frame: any): void {
    if (this.context.state !== 'running') this.context.resume().catch(() => undefined);

    const channels = Math.max(1, frame.numberOfChannels || 2);
    const frames = Math.max(0, frame.numberOfFrames || 0);
    const sampleRate = Math.max(1, frame.sampleRate || this.context.sampleRate);
    const timestamp = typeof frame.timestamp === 'number' ? frame.timestamp : 0;
    if (!frames) return;

    this.enqueuedFrames += 1;
    this.lastFrameSamples = frames;
    this.lastTimestampUs = timestamp;

    const durationUs = (frames / sampleRate) * 1_000_000;
    const mediaGapMs = this.expectedNextTimestampUs === undefined
      ? 0
      : (timestamp - this.expectedNextTimestampUs) / 1000;
    const rawQueueMs = (this.scheduledUntil - this.context.currentTime) * 1000;
    const resetReason = decideAudioTimelineReset({
      queuedMs: rawQueueMs,
      mediaGapMs,
      maxQueueMs: this.maxQueueMs,
      hasStarted: this.expectedNextTimestampUs !== undefined
    });
    if (resetReason !== 'none') {
      if (resetReason === 'underrun') this.underrunCount += 1;
      this.smoothTimelineReset();
    }
    const startsNewTimeline = this.expectedNextTimestampUs === undefined;

    const audioBuffer = this.context.createBuffer(channels, frames, sampleRate);
    for (let channel = 0; channel < channels; channel += 1) {
      const data = new Float32Array(frames);
      try {
        frame.copyTo(data, { planeIndex: channel, format: 'f32-planar' });
      } catch {
        frame.copyTo(data, { planeIndex: channel });
      }
      audioBuffer.copyToChannel(data, channel);
    }

    const now = this.context.currentTime;
    const when = calculateAudioStartTime(now, this.scheduledUntil, this.startupBufferMs, startsNewTimeline);
    if (startsNewTimeline) {
      this.clock.reset();
      this.clock.bind(timestamp, when);
      this.fadeInAt(when);
    }

    const source = this.context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.gain);
    source.start(when);
    this.scheduledUntil = when + audioBuffer.duration;
    this.expectedNextTimestampUs = timestamp + durationUs;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      try { source.disconnect(); } catch {}
    };
  }

  queuedMs(): number {
    return Math.max(0, (this.scheduledUntil - this.context.currentTime) * 1000);
  }

  currentTimeMs(): number {
    const mediaUs = this.clock.mediaTimeUs(this.context.currentTime);
    return mediaUs === undefined ? 0 : mediaUs / 1000;
  }

  isRunning(): boolean {
    return this.context.state === 'running';
  }

  delayUntilMediaTimeMs(mediaUs: number): number | undefined {
    const target = this.clock.targetContextTime(mediaUs);
    if (target === undefined) return undefined;
    return (target - this.context.currentTime) * 1000;
  }

  diagnostics(): {
    contextState: AudioContextState;
    enqueuedFrames: number;
    scheduledSources: number;
    lastFrameSamples: number;
    lastTimestampUs: number;
    timelineResetCount: number;
    underrunCount: number;
    startupBufferMs: number;
  } {
    return {
      contextState: this.context.state,
      enqueuedFrames: this.enqueuedFrames,
      scheduledSources: this.sources.size,
      lastFrameSamples: this.lastFrameSamples,
      lastTimestampUs: this.lastTimestampUs,
      timelineResetCount: this.timelineResetCount,
      underrunCount: this.underrunCount,
      startupBufferMs: this.startupBufferMs
    };
  }

  reset(smooth = true): void {
    const now = this.context.currentTime;
    if (smooth && this.sources.size > 0 && this.context.state !== 'closed') {
      const fadeOutAt = now + this.fadeSeconds;
      const fadeInAt = fadeOutAt + this.fadeSeconds;
      const param = this.gain.gain;
      this.holdGainAt(now);
      param.linearRampToValueAtTime(0, fadeOutAt);
      this.stopScheduledSources(fadeOutAt);
      param.setValueAtTime(0, fadeOutAt);
      param.linearRampToValueAtTime(this.volume, fadeInAt);
      this.scheduledUntil = fadeInAt;
      this.timelineResetCount += 1;
    } else {
      this.stopScheduledSources(now);
      this.scheduledUntil = now;
    }
    this.clock.reset();
    this.expectedNextTimestampUs = undefined;
    this.enqueuedFrames = 0;
    this.lastFrameSamples = 0;
    this.lastTimestampUs = 0;
  }

  close(): void {
    this.reset(false);
    this.context.close().catch(() => undefined);
  }

  private smoothTimelineReset(): void {
    const now = this.context.currentTime;
    const fadeOutAt = now + this.fadeSeconds;
    const fadeInAt = fadeOutAt + this.fadeSeconds;
    const param = this.gain.gain;
    this.holdGainAt(now);
    param.linearRampToValueAtTime(0, fadeOutAt);
    this.stopScheduledSources(fadeOutAt);
    param.setValueAtTime(0, fadeOutAt);
    param.linearRampToValueAtTime(this.volume, fadeInAt);
    this.clock.reset();
    this.scheduledUntil = fadeInAt + this.startupBufferMs / 1000;
    this.expectedNextTimestampUs = undefined;
    this.timelineResetCount += 1;
  }

  private fadeInAt(time: number): void {
    const param = this.gain.gain;
    param.cancelScheduledValues(time);
    param.setValueAtTime(0, time);
    param.linearRampToValueAtTime(this.volume, time + this.fadeSeconds);
  }

  private holdGainAt(time: number): void {
    const param = this.gain.gain;
    const hold = (param as any).cancelAndHoldAtTime;
    if (typeof hold === 'function') {
      try {
        hold.call(param, time);
        return;
      } catch {}
    }
    const value = param.value;
    param.cancelScheduledValues(time);
    param.setValueAtTime(value, time);
  }

  private stopScheduledSources(stopAt: number): void {
    for (const source of this.sources) {
      try { source.stop(stopAt); } catch {}
    }
    this.sources.clear();
  }
}
