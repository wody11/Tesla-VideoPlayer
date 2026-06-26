// Canvas 2D renderer for WebCodecs VideoFrame output.
export class CanvasRenderer {
  readonly type = 'canvas2d' as const;
  private ctx: CanvasRenderingContext2D;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context is not available.');
    this.ctx = ctx;
  }

  draw(frame: any): void {
    this.resize(frame.displayWidth || frame.codedWidth, frame.displayHeight || frame.codedHeight);
    this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  destroy(): void {
    this.clear();
  }

  private resize(width: number, height: number): void {
    if (width && height && (this.canvas.width !== width || this.canvas.height !== height)) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }
}
