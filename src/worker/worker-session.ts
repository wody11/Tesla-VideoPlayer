/*
 * Tesla-VideoPlayer is based on Jessibuca open source architecture.
 * Jessibuca is licensed under GPL-3.0. See THIRD_PARTY_NOTICES.md.
 */

import type { TeslaSourceType } from '../player/player-options';
import type { TeslaWorkerCommand, TeslaWorkerEvent } from './worker-protocol';
import { WorkerClient } from './worker-client';

export class WorkerSession {
  readonly client: WorkerClient;
  private reconnectCount = 0;
  private stopped = false;

  constructor(
    workerUrl: string | URL,
    onMessage: (message: TeslaWorkerEvent) => void,
    onError: (error: Error) => void
  ) {
    this.client = new WorkerClient(workerUrl, onMessage, onError);
  }

  open(sourceType: TeslaSourceType, url: string, options: Partial<TeslaWorkerCommand> = {}): void {
    this.stopped = false;
    this.client.open();
    if (sourceType === 'ws-flv') this.client.post({ type: 'open-ws-flv', url });
    else if (sourceType === 'hls') this.client.post({ type: 'open-hls', url, ...(options as any) });
    else if (sourceType === 'mp4') this.client.post({ type: 'open-mp4', url });
    else this.client.post({ type: 'open-http-flv', url });
  }

  pause(): void { this.client.post({ type: 'pause' }); }
  resume(): void { this.client.post({ type: 'resume' }); }

  stop(): void {
    this.stopped = true;
    this.client.close();
  }

  markReconnect(): number {
    this.reconnectCount += 1;
    return this.reconnectCount;
  }

  getReconnectCount(): number {
    return this.reconnectCount;
  }
}

