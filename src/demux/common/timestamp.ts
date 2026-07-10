/*
 * Timestamp helpers for AV sync and demux output normalization.
 */

export const usToMs = (value: number): number => value / 1000;
export const msToUs = (value: number): number => Math.round(value * 1000);

export class TimestampUnwrapper {
  private wrapOffset = 0;
  private last?: number;

  unwrap(value: number, modulo = 0x200000000): number {
    if (this.last !== undefined) {
      if (value < this.last && this.last - value > modulo / 2) this.wrapOffset += modulo;
      else if (value > this.last && value - this.last > modulo / 2) this.wrapOffset -= modulo;
    }
    this.last = value;
    return value + this.wrapOffset;
  }
}

