/*
 * Render manager mirrors Jessibuca's video loader split and owns renderer
 * replacement without recreating the player.
 */

import { CanvasRenderer } from './canvas-renderer';
import { WebGLRenderer } from './webgl-renderer';
import { normalizeRenderer, RendererType } from './render-utils';

export class RenderManager {
  private renderer: CanvasRenderer | WebGLRenderer;

  constructor(private canvas: HTMLCanvasElement, type: 'canvas' | 'webgl' | 'canvas2d' = 'webgl') {
    this.renderer = this.create(normalizeRenderer(type));
  }

  get type(): RendererType {
    return this.renderer.type;
  }

  setRenderer(type: 'canvas' | 'webgl' | 'canvas2d'): void {
    const normalized = normalizeRenderer(type);
    if (this.renderer.type === normalized) return;
    this.renderer.destroy();
    this.renderer = this.create(normalized);
  }

  draw(frame: any): void { this.renderer.draw(frame); }
  clear(): void { this.renderer.clear(); }
  destroy(): void { this.renderer.destroy(); }

  private create(type: RendererType): CanvasRenderer | WebGLRenderer {
    if (type === 'canvas2d') return new CanvasRenderer(this.canvas);
    try {
      return new WebGLRenderer(this.canvas);
    } catch {
      return new CanvasRenderer(this.canvas);
    }
  }
}

