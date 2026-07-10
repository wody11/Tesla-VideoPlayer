/*
 * AV sync coordinator. Audio clock is preferred; wall-clock drift corrector is
 * used before audio starts.
 */

import { DriftCorrector } from './drift-corrector';

export class AvSync {
  private drift = new DriftCorrector();

  videoDelayMs(timestampUs: number, audioDelay?: (timestampUs: number) => number | undefined): number {
    const audioDelayMs = audioDelay?.(timestampUs);
    if (audioDelayMs !== undefined) return audioDelayMs;
    this.drift.bind(timestampUs);
    return this.drift.delayMs(timestampUs);
  }

  reset(): void {
    this.drift.reset();
  }
}

