// Typed event emitter used by the public player facade.
export type TeslaPlayerEventMap = {
  state: string;
  error: Error;
  stats: unknown;
  log: string;
  firstFrame: number;
};

type Listener<T> = (payload: T) => void;

export class PlayerEvents {
  private listeners: { [K in keyof TeslaPlayerEventMap]?: Listener<TeslaPlayerEventMap[K]>[] } = {};

  on<K extends keyof TeslaPlayerEventMap>(event: K, listener: Listener<TeslaPlayerEventMap[K]>): () => void {
    const list = this.listeners[event] || [];
    list.push(listener);
    this.listeners[event] = list;
    return () => this.off(event, listener);
  }

  off<K extends keyof TeslaPlayerEventMap>(event: K, listener: Listener<TeslaPlayerEventMap[K]>): void {
    const list = this.listeners[event];
    if (!list) return;
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  }

  emit<K extends keyof TeslaPlayerEventMap>(event: K, payload: TeslaPlayerEventMap[K]): void {
    for (const listener of this.listeners[event] || []) {
      try {
        listener(payload);
      } catch {
        // User listeners must not break playback internals.
      }
    }
  }

  clear(): void {
    this.listeners = {};
  }
}
