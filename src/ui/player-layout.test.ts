import { calculateResponsivePlayerHeight } from './player-layout';

describe('calculateResponsivePlayerHeight', () => {
  test('derives a 16:9 height from width', () => {
    expect(calculateResponsivePlayerHeight({ width: 360, viewportHeight: 800, aspectRatio: 16 / 9, maxViewportHeightRatio: 1 })).toBe(202);
  });

  test('caps a tall player to the visible viewport', () => {
    expect(calculateResponsivePlayerHeight({ width: 500, viewportHeight: 700, aspectRatio: 9 / 16, maxViewportHeightRatio: 0.9 })).toBe(630);
  });

  test('sanitizes invalid ratios', () => {
    expect(calculateResponsivePlayerHeight({ width: 320, viewportHeight: 600, aspectRatio: 0, maxViewportHeightRatio: 4 })).toBe(180);
  });
});
