export function isUsableMediaTimestamp(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}
