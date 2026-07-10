/*
 * Tesla-VideoPlayer is based on Jessibuca open source architecture.
 * Jessibuca is licensed under GPL-3.0. See THIRD_PARTY_NOTICES.md.
 */

export interface StreamLoader {
  open(url: string): Promise<void> | void;
  pause(): void;
  resume(): void;
  stop(): void;
}

export type StreamChunkHandler = (chunk: Uint8Array) => void;
export type StreamStatusHandler = (message: string) => void;

