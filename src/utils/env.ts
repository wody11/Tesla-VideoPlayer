/*
 * Tesla-VideoPlayer is based on Jessibuca open source architecture.
 * Jessibuca is licensed under GPL-3.0. See THIRD_PARTY_NOTICES.md.
 */

export const env = {
  isBrowser: typeof window !== 'undefined',
  isSecureContext: typeof window !== 'undefined' ? window.isSecureContext : false,
  userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : ''
};

