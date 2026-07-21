/**
 * Tracks one active asynchronous playback session.
 *
 * Starting or invalidating a session makes every previously issued token stale,
 * so late Worker/WebCodecs callbacks can be ignored safely.
 */
export class SessionGeneration {
  private generation = 0;
  private active = false;

  begin(): number {
    this.generation += 1;
    this.active = true;
    return this.generation;
  }

  invalidate(): void {
    this.generation += 1;
    this.active = false;
  }

  isCurrent(sessionId: number): boolean {
    return this.active && sessionId === this.generation;
  }

  get current(): number {
    return this.generation;
  }
}
