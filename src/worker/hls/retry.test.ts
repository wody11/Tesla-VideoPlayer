import { classifyError, nextBackoff, resetBackoff } from './retry';

describe('HLS retry policy', () => {
  test('classifyError', () => {
    expect(classifyError('playlist http 404')).toBe('http');
    expect(classifyError(new Error('NetworkError when attempting to fetch'))).toBe('network');
    expect(classifyError('decrypt AES padding')).toBe('decrypt');
    expect(classifyError('parse m3u8 failed')).toBe('parse');
    expect(classifyError('weird')).toBe('unknown');
  });

  test('nextBackoff grows with jitter bounded by max', () => {
    const policy = { baseMs: 500, maxMs: 4000, jitter: 0 };
    const b1 = nextBackoff(undefined, policy);
    const b2 = nextBackoff(b1, policy);
    const b3 = nextBackoff(b2, policy);
    expect(b1).toBe(500);
    expect(b2).toBe(1000);
    expect(b3).toBe(2000);
    const b4 = nextBackoff(3000, policy);
    expect(b4).toBe(4000);
    const b5 = nextBackoff(4000, policy);
    expect(b5).toBe(4000);
    expect(resetBackoff(policy)).toBe(500);
  });
});
