/*
 * Timestamp-sorted video frame queue with bounded dropping.
 */

export interface QueuedFrame {
  frame: any;
  timestamp: number;
}

export class FrameQueue {
  private frames: QueuedFrame[] = [];

  push(item: QueuedFrame): void {
    this.frames.push(item);
    this.frames.sort((a, b) => a.timestamp - b.timestamp);
  }

  shift(): QueuedFrame | undefined { return this.frames.shift(); }
  peek(): QueuedFrame | undefined { return this.frames[0]; }
  get length(): number { return this.frames.length; }

  dropOldest(): QueuedFrame | undefined {
    return this.frames.shift();
  }

  clear(): void {
    for (const item of this.frames) {
      try { item.frame.close(); } catch {}
    }
    this.frames = [];
  }
}

