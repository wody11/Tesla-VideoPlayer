export type TeslaAspectRatio = number | 'video';

export interface PlayerLayoutOptions {
  responsive: boolean;
  aspectRatio: TeslaAspectRatio;
  maxViewportHeightRatio: number;
}

export interface PlayerSizeInput {
  width: number;
  viewportHeight: number;
  aspectRatio: number;
  maxViewportHeightRatio: number;
}

export function calculateResponsivePlayerHeight(input: PlayerSizeInput): number {
  const width = Math.max(0, Number(input.width) || 0);
  const viewportHeight = Math.max(0, Number(input.viewportHeight) || 0);
  const aspectRatio = Number.isFinite(input.aspectRatio) && input.aspectRatio > 0 ? input.aspectRatio : 16 / 9;
  const viewportRatio = Number.isFinite(input.maxViewportHeightRatio)
    ? Math.max(0.25, Math.min(1, input.maxViewportHeightRatio))
    : 1;
  if (!width) return 0;
  const widthBasedHeight = width / aspectRatio;
  const viewportCap = viewportHeight ? viewportHeight * viewportRatio : widthBasedHeight;
  return Math.max(1, Math.floor(Math.min(widthBasedHeight, viewportCap)));
}

const MANAGED_STYLES = [
  'width', 'height', 'maxWidth', 'maxHeight', 'minHeight', 'overflow', 'position',
  'aspectRatio', 'touchAction', 'contain'
] as const;

const RESPONSIVE_STYLES: ManagedStyle[] = [
  'width', 'height', 'maxWidth', 'maxHeight', 'minHeight', 'aspectRatio', 'touchAction', 'contain'
];

type ManagedStyle = typeof MANAGED_STYLES[number];

export class PlayerLayoutController {
  private original = new Map<ManagedStyle, string>();
  private observer?: ResizeObserver;
  private videoAspectRatio = 16 / 9;
  private destroyed = false;

  constructor(private container: HTMLElement, private options: PlayerLayoutOptions) {
    for (const property of MANAGED_STYLES) this.original.set(property, container.style[property]);
    this.applyBaseStyles();
    this.observe();
    this.update();
  }

  updateOptions(values: Partial<PlayerLayoutOptions>): void {
    const wasResponsive = this.options.responsive;
    this.options = { ...this.options, ...values };
    if (wasResponsive && !this.options.responsive) {
      this.restoreResponsiveStyles();
      this.applyBaseStyles();
      return;
    }
    this.applyBaseStyles();
    this.update();
  }

  setVideoSize(width: number, height: number): void {
    if (width > 0 && height > 0) {
      this.videoAspectRatio = width / height;
      if (this.options.aspectRatio === 'video') this.update();
    }
  }

  update = (): void => {
    if (this.destroyed || !this.options.responsive) return;
    const fullscreen = document.fullscreenElement === this.container;
    if (fullscreen) {
      this.container.style.width = '100%';
      this.container.style.height = '100%';
      this.container.style.maxHeight = '100dvh';
      this.container.style.aspectRatio = 'auto';
      return;
    }

    const parentWidth = this.container.parentElement?.clientWidth || 0;
    const ownWidth = this.container.getBoundingClientRect().width || this.container.clientWidth || 0;
    const width = parentWidth || ownWidth;
    const viewportHeight = window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight;
    const aspectRatio = this.options.aspectRatio === 'video' ? this.videoAspectRatio : this.options.aspectRatio;
    const height = calculateResponsivePlayerHeight({
      width,
      viewportHeight,
      aspectRatio,
      maxViewportHeightRatio: this.options.maxViewportHeightRatio
    });
    if (!height) return;
    this.container.style.width = '100%';
    this.container.style.height = `${height}px`;
    this.container.style.maxHeight = 'calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom))';
    this.container.style.aspectRatio = String(aspectRatio);
  };

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.observer?.disconnect();
    window.removeEventListener('resize', this.update);
    window.removeEventListener('orientationchange', this.update);
    window.visualViewport?.removeEventListener('resize', this.update);
    document.removeEventListener('fullscreenchange', this.update);
    this.restoreManagedStyles();
  }

  private restoreManagedStyles(): void {
    for (const property of MANAGED_STYLES) this.container.style[property] = this.original.get(property) || '';
  }

  private restoreResponsiveStyles(): void {
    for (const property of RESPONSIVE_STYLES) this.container.style[property] = this.original.get(property) || '';
  }

  private applyBaseStyles(): void {
    this.container.style.position ||= 'relative';
    this.container.style.overflow = 'hidden';
    if (!this.options.responsive) return;
    this.container.style.maxWidth = '100%';
    this.container.style.minHeight = '0';
    this.container.style.touchAction = 'manipulation';
    this.container.style.contain = 'layout paint';
  }

  private observe(): void {
    if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(() => this.update());
      this.observer.observe(this.container.parentElement || this.container);
    }
    window.addEventListener('resize', this.update, { passive: true });
    window.addEventListener('orientationchange', this.update, { passive: true });
    window.visualViewport?.addEventListener('resize', this.update, { passive: true });
    document.addEventListener('fullscreenchange', this.update);
  }
}
