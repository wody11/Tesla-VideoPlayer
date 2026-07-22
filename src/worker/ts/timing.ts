// Safe MPEG clock helpers. Avoid JavaScript's signed 32-bit bitwise coercion.
export function decodePcrTimestampUs(data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 6 > data.length) return 0;
  const base = data[offset] * 33_554_432
    + data[offset + 1] * 131_072
    + data[offset + 2] * 512
    + data[offset + 3] * 2
    + (data[offset + 4] >> 7);
  const extension = ((data[offset + 4] & 0x01) << 8) | data[offset + 5];
  return Math.round((base * 300 + extension) / 27);
}

export function estimateVideoFrameDurationUs(
  previousPesPtsUs: number | undefined,
  currentPesPtsUs: number,
  previousAccessUnitCount: number,
  fallbackUs = 33_333
): number {
  const fallback = Math.max(5_000, Math.min(200_000, Math.round(fallbackUs) || 33_333));
  if (previousPesPtsUs === undefined) return fallback;
  const candidate = (currentPesPtsUs - previousPesPtsUs) / Math.max(1, previousAccessUnitCount);
  return Number.isFinite(candidate) && candidate >= 5_000 && candidate <= 200_000
    ? Math.round(candidate)
    : fallback;
}
