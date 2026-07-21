import { isUsableMediaTimestamp } from './media-timestamp';

describe('media timestamp validation', () => {
  test('accepts a valid stream that starts at timestamp zero', () => {
    expect(isUsableMediaTimestamp(0)).toBe(true);
  });

  test('rejects negative and non-finite timestamps', () => {
    expect(isUsableMediaTimestamp(-1)).toBe(false);
    expect(isUsableMediaTimestamp(Number.NaN)).toBe(false);
    expect(isUsableMediaTimestamp(Number.POSITIVE_INFINITY)).toBe(false);
  });
});
