/*
 * Small bounded queue used by audio and sync diagnostics.
 */

export class AudioQueue<T> {
  private items: T[] = [];

  push(item: T): void { this.items.push(item); }
  shift(): T | undefined { return this.items.shift(); }
  clear(): void { this.items = []; }
  get length(): number { return this.items.length; }
  toArray(): T[] { return this.items.slice(); }
}

