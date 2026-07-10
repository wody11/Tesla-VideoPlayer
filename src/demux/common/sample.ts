/*
 * Tesla-VideoPlayer is based on Jessibuca open source architecture.
 * Jessibuca is licensed under GPL-3.0. See THIRD_PARTY_NOTICES.md.
 */

export interface TeslaMediaSample {
  kind: 'video' | 'audio';
  timestamp: number;
  duration?: number;
  key?: boolean;
  data: ArrayBuffer;
}

