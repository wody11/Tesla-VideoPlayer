/*
 * requestAnimationFrame scheduler for decoded frames.
 */

export class VideoScheduler {
  private id?: number;

  request(callback: () => void): void {
    if (this.id !== undefined) return;
    this.id = requestAnimationFrame(() => {
      this.id = undefined;
      callback();
    });
  }

  cancel(): void {
    if (this.id !== undefined) cancelAnimationFrame(this.id);
    this.id = undefined;
  }
}

