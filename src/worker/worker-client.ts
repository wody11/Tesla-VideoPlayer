/*
 * Tesla-VideoPlayer is based on Jessibuca open source architecture.
 * Jessibuca is licensed under GPL-3.0. See THIRD_PARTY_NOTICES.md.
 */

import type { TeslaWorkerCommand, TeslaWorkerEvent } from './worker-protocol';

export class WorkerClient {
  private worker?: Worker;

  constructor(
    private workerUrl: string | URL,
    private onMessage: (message: TeslaWorkerEvent) => void,
    private onError: (error: Error) => void
  ) {}

  open(): void {
    this.close();
    this.worker = new Worker(this.workerUrl, { type: 'module' });
    this.worker.onmessage = event => this.onMessage(event.data as TeslaWorkerEvent);
    this.worker.onerror = event => this.onError(new Error(event.message || 'Tesla worker failed.'));
  }

  post(command: TeslaWorkerCommand): void {
    this.worker?.postMessage(command);
  }

  close(): void {
    try {
      this.worker?.postMessage({ type: 'stop' } satisfies TeslaWorkerCommand);
    } catch {}
    this.worker?.terminate();
    this.worker = undefined;
  }
}

