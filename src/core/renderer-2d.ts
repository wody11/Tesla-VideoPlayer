export class Renderer2D {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D context not available');
    this.ctx = ctx;
  }
  async draw(frame: ImageBitmap | HTMLCanvasElement | VideoFrame) {
    try {
      // Use createImageBitmap for better performance where supported
      let bmp: ImageBitmap | null = null;
      try { bmp = await createImageBitmap(frame as any); } catch { bmp = null; }
      const dpr = (typeof window !== 'undefined' && (window as any).devicePixelRatio) ? (window as any).devicePixelRatio : 1;
      const w = this.canvas.width; const h = this.canvas.height;
      // scale canvas for high-dpi
      if (dpr && dpr !== 1) {
        try { this.ctx.save(); this.ctx.scale(1,1); } catch {}
      }
      if (bmp) {
        try { this.ctx.drawImage(bmp, 0, 0, w, h); } catch {} finally { try { bmp.close(); } catch {} }
      } else {
        try { this.ctx.drawImage(frame as any, 0, 0, w, h); } catch {}
      }
      try { if (dpr && dpr !== 1) this.ctx.restore(); } catch {}
    } catch (e) { /* ignore */ }
  }
  resize(w: number, h: number) { try { this.canvas.width = w; this.canvas.height = h; } catch {} }
}
