/*
 * Tesla-VideoPlayer is based on Jessibuca open source architecture.
 * Jessibuca is licensed under GPL-3.0. See THIRD_PARTY_NOTICES.md.
 */

export type GenericListener = (...args: any[]) => void;

export class EventEmitter {
  private listeners = new Map<string, GenericListener[]>();

  on(event: string, listener: GenericListener): () => void {
    const list = this.listeners.get(event) || [];
    list.push(listener);
    this.listeners.set(event, list);
    return () => this.off(event, listener);
  }

  off(event: string, listener: GenericListener): void {
    const list = this.listeners.get(event);
    if (!list) return;
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) || []) listener(...args);
  }

  clear(): void {
    this.listeners.clear();
  }
}

