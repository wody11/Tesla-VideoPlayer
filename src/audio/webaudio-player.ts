import { AudioClock } from './audio-clock';

// Schedules decoded AudioData through WebAudio without using media elements.
export class WebAudioPlayer {
  readonly clock = new AudioClock();
  private context: AudioContext;
  private gain: GainNode;
  private scheduledUntil = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private targetQueueMs = 1500;
  private hardResetQueueMs = 7000;
  private enqueuedFrames = 0;
  private lastFrameSamples = 0;
  private lastTimestampUs = 0;

  constructor() {
    const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) throw new Error('WebAudio is not available.');
    this.context = new Ctor();
    this.gain = this.context.createGain();
    this.gain.gain.value = 1;
    this.gain.connect(this.context.destination);
  }

  async resume(): Promise<void> {
    if (this.context.state !== 'running') await this.context.resume();
  }

  pause(): void {
    this.context.suspend().catch(() => undefined);
  }

  setVolume(value: number): void {
    const volume = Math.max(0, Math.min(1, Number(value) || 0));
    this.gain.gain.setValueAtTime(volume, this.context.currentTime);
  }

  setMaxQueueMs(value: number): void {
    this.targetQueueMs = Math.max(300, Math.min(5000, Number(value) || 1500));
    this.hardResetQueueMs = Math.max(this.targetQueueMs * 2, this.targetQueueMs + 1000);
  }

  enqueue(frame: any): void {
    if (this.context.state !== 'running') this.context.resume().catch(() => undefined);

    const channels = frame.numberOfChannels || 2;
    const frames = frame.numberOfFrames || 0;
    const sampleRate = frame.sampleRate || this.context.sampleRate;
    const timestamp = typeof frame.timestamp === 'number' ? frame.timestamp : 0;
    this.enqueuedFrames += 1;
    this.lastFrameSamples = frames;
    this.lastTimestampUs = timestamp;

    if (this.queuedMs() > this.hardResetQueueMs) {
      this.stopScheduledSources();
      this.clock.reset();
      this.scheduledUntil = this.context.currentTime + this.targetQueueMs / 1000;
    }

    this.clock.bind(timestamp, Math.max(this.context.currentTime + this.targetQueueMs / 1000, this.scheduledUntil || 0));

    const audioBuffer = this.context.createBuffer(channels, frames, sampleRate);
    for (let ch = 0; ch < channels; ch++) {
      const data = new Float32Array(frames);
      try {
        frame.copyTo(data, { planeIndex: ch });
      } catch {
        frame.copyTo(data);
      }
      audioBuffer.copyToChannel(data, ch);
    }

    const source = this.context.createBufferSource();
    source.buffer = audioBuffer;
    const queueMs = this.queuedMs();
    const catchupRate = queueMs > this.targetQueueMs
      ? Math.min(1.12, 1 + ((queueMs - this.targetQueueMs) / Math.max(this.targetQueueMs, 1)) * 0.06)
      : 1;
    source.playbackRate.setValueAtTime(catchupRate, this.context.currentTime);
    source.connect(this.gain);
    const target = this.clock.targetContextTime(timestamp);
    const when = Math.max(this.context.currentTime + 0.01, target ?? this.scheduledUntil ?? this.context.currentTime);
    source.start(when);
    this.scheduledUntil = Math.max(this.scheduledUntil, when + audioBuffer.duration / catchupRate);
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
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
  } {
    return {
      contextState: this.context.state,
      enqueuedFrames: this.enqueuedFrames,
      scheduledSources: this.sources.size,
      lastFrameSamples: this.lastFrameSamples,
      lastTimestampUs: this.lastTimestampUs
    };
  }

  close(): void {
    this.stopScheduledSources();
    this.clock.reset();
    this.context.close().catch(() => undefined);
  }

  private stopScheduledSources(): void {
    for (const source of this.sources) {
      try { source.stop(); } catch {}
      try { source.disconnect(); } catch {}
    }
    this.sources.clear();
  }
}
