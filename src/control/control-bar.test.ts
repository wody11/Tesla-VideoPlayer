import { formatPlayerTime } from './control-bar';

describe('formatPlayerTime', () => {
  test('formats short and long media times', () => {
    expect(formatPlayerTime(65)).toBe('1:05');
    expect(formatPlayerTime(3661)).toBe('1:01:01');
  });
});
