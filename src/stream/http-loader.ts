/*
 * Fetch loader modeled after Jessibuca's stream/fetchLoader.js.
 */

import type { StreamChunkHandler, StreamLoader, StreamStatusHandler } from './stream-loader';

export class HttpLoader implements StreamLoader {
  private aborter?: AbortController;
  private paused = false;

  constructor(private onChunk: StreamChunkHandler, private onStatus: StreamStatusHandler = () => undefined) {}

  async open(url: string): Promise<void> {
    this.stop();
    this.aborter = new AbortController();
    const response = await fetch(url, { signal: this.aborter.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    if (!response.body) throw new Error('ReadableStream is not available.');
    this.onStatus('open');
    const reader = response.body.getReader();
    while (!this.aborter.signal.aborted) {
      if (this.paused) {
        await new Promise(resolve => setTimeout(resolve, 30));
        continue;
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value) this.onChunk(value);
    }
    this.onStatus('end');
  }

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  stop(): void { this.aborter?.abort(); this.aborter = undefined; }
}

