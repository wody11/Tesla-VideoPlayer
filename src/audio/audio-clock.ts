// Maps media timestamps to AudioContext time so video can follow audio.
export class AudioClock {
  private baseMediaUs?: number;
  private baseContextTime?: number;

  reset(): void {
    this.baseMediaUs = undefined;
    this.baseContextTime = undefined;
  }

  bind(mediaUs: number, contextTime: number): void {
    if (this.baseMediaUs === undefined) {
      this.baseMediaUs = mediaUs;
      this.baseContextTime = contextTime;
    }
  }

  mediaTimeUs(contextTime: number): number | undefined {
    if (this.baseMediaUs === undefined || this.baseContextTime === undefined) return undefined;
    return this.baseMediaUs + (contextTime - this.baseContextTime) * 1_000_000;
  }

  targetContextTime(mediaUs: number): number | undefined {
    if (this.baseMediaUs === undefined || this.baseContextTime === undefined) return undefined;
    return this.baseContextTime + (mediaUs - this.baseMediaUs) / 1_000_000;
  }
}
