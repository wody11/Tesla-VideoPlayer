export type RendererType = 'canvas2d' | 'webgl';

export function normalizeRenderer(value?: 'canvas' | 'webgl' | 'canvas2d'): RendererType {
  return value === 'canvas' || value === 'canvas2d' ? 'canvas2d' : 'webgl';
}

