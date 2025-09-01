export type RetryCategory = 'network' | 'http' | 'decrypt' | 'parse' | 'unknown';

export interface RetryPolicy {
  baseMs: number;    // 初始回退
  maxMs: number;     // 最大回退
  jitter?: number;   // 抖动比例（0~1），默认 0.2
  maxAttempts?: number; // 可选：最大连续尝试次数（用于某些不可恢复错误）
}

export function classifyError(err: unknown): RetryCategory {
  const s = String(err || '');
  if (/http\s+\d{3}/i.test(s)) return 'http';
  if (/NetworkError|TypeError: Failed to fetch|network/i.test(s)) return 'network';
  if (/decrypt|AES|cipher|padding/i.test(s)) return 'decrypt';
  if (/parse|format|syntax/i.test(s)) return 'parse';
  return 'unknown';
}

export function nextBackoff(prevMs: number | undefined, policy: RetryPolicy): number {
  const base = Math.max(1, policy.baseMs);
  const max = Math.max(base, policy.maxMs);
  const jitter = Math.min(1, Math.max(0, policy.jitter ?? 0.2));
  let next = prevMs ? Math.min(max, Math.max(base, Math.floor(prevMs * 2))) : base;
  // 应用抖动：±jitter 百分比
  if (jitter > 0) {
    const delta = Math.floor(next * jitter);
    const rnd = (Math.random() * 2 - 1); // [-1, 1)
    next = Math.max(base, Math.min(max, next + Math.floor(delta * rnd)));
  }
  return next;
}

export function resetBackoff(policy: RetryPolicy): number { return policy.baseMs; }
