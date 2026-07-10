/*
 * WebSocket loader modeled after Jessibuca's stream/websocketLoader.js.
 */

import type { StreamChunkHandler, StreamLoader, StreamStatusHandler } from './stream-loader';

export class WebSocketLoader implements StreamLoader {
  private socket?: WebSocket;
  private paused = false;

  constructor(private onChunk: StreamChunkHandler, private onStatus: StreamStatusHandler = () => undefined) {}

  open(url: string): void {
    this.stop();
    this.socket = new WebSocket(url);
    this.socket.binaryType = 'arraybuffer';
    this.socket.onopen = () => this.onStatus('open');
    this.socket.onclose = () => this.onStatus('end');
    this.socket.onerror = () => this.onStatus('error');
    this.socket.onmessage = event => {
      if (this.paused) return;
      if (event.data instanceof ArrayBuffer) this.onChunk(new Uint8Array(event.data));
      else if (event.data instanceof Blob) event.data.arrayBuffer().then(buffer => this.onChunk(new Uint8Array(buffer)));
    };
  }

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  stop(): void { this.socket?.close(); this.socket = undefined; }
}

