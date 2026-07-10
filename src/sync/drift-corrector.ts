/*
 * Maintains a wall-clock mapping for video timestamps when audio clock is not
 * yet available or cannot provide a target.
 */

export class DriftCorrector {
  private mediaBaseUs?: number;
  private wallBaseMs?: number;

  bind(timestampUs: number): void {
    if (this.mediaBaseUs === undefined) {
      this.mediaBaseUs = timestampUs;
      this.wallBaseMs = performance.now();
    }
  }

  delayMs(timestampUs: number): number {
    if (this.mediaBaseUs === undefined || this.wallBaseMs === undefined) return 0;
    return this.wallBaseMs + (timestampUs - this.mediaBaseUs) / 1000 - performance.now();
  }

  reset(): void {
    this.mediaBaseUs = undefined;
    this.wallBaseMs = undefined;
  }
}

