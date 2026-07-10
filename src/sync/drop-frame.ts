/*
 * Jessibuca-style late-frame drop decision.
 */

export function shouldDropFrame(delayMs: number, lateDropMs: number): boolean {
  return delayMs < -lateDropMs;
}

