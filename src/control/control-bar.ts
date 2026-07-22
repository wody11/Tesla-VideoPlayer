import type { TeslaPlayer } from '../player/tesla-player';

const STYLE_ID = 'tesla-player-control-styles';

export function formatPlayerTime(seconds: number): string {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

export class ControlBar {
  readonly element: HTMLDivElement;
  private playButton: HTMLButtonElement;
  private stopButton: HTMLButtonElement;
  private progress: HTMLInputElement;
  private time: HTMLSpanElement;
  private muteButton: HTMLButtonElement;
  private volume: HTMLInputElement;
  private stateLabel: HTMLSpanElement;
  private timer?: number;
  private hideTimer?: number;
  private unsubscribe?: () => void;
  private previousVolume = 1;
  private scrubbing = false;
  private container: HTMLElement;
  private originalTabIndex: string | null;

  constructor(private player: TeslaPlayer) {
    ensureStyles();
    this.container = player.getContainer();
    this.originalTabIndex = this.container.getAttribute('tabindex');
    this.element = document.createElement('div');
    this.element.className = 'tesla-control-bar';
    this.element.setAttribute('role', 'group');
    this.element.setAttribute('aria-label', 'Video controls');

    this.stateLabel = document.createElement('span');
    this.stateLabel.className = 'tesla-control-state';

    this.playButton = button('▶', '播放 / 暂停', () => this.player.togglePlayback().catch(error => this.player.events.emit('error', error)));
    this.playButton.classList.add('tesla-control-primary');
    this.stopButton = button('■', '停止', () => this.player.stop());

    this.progress = document.createElement('input');
    this.progress.className = 'tesla-control-progress';
    this.progress.type = 'range';
    this.progress.min = '0';
    this.progress.max = '1';
    this.progress.step = '0.01';
    this.progress.value = '0';
    this.progress.setAttribute('aria-label', '播放进度');
    this.progress.addEventListener('pointerdown', () => { this.scrubbing = true; });
    this.progress.addEventListener('input', () => this.updateTimePreview());
    this.progress.addEventListener('change', () => {
      this.scrubbing = false;
      this.player.seek(Number(this.progress.value));
    });

    this.time = document.createElement('span');
    this.time.className = 'tesla-control-time';
    this.time.textContent = '0:00 / 0:00';

    this.muteButton = button('🔊', '静音', () => this.toggleMute());
    this.volume = document.createElement('input');
    this.volume.className = 'tesla-control-volume';
    this.volume.type = 'range';
    this.volume.min = '0';
    this.volume.max = '1';
    this.volume.step = '0.01';
    this.volume.value = String(this.player.getVolume());
    this.volume.setAttribute('aria-label', '音量');
    this.volume.addEventListener('input', () => {
      const value = Number(this.volume.value);
      if (value > 0) this.previousVolume = value;
      this.player.setVolume(value);
      this.updateVolumeIcon(value);
    });

    const screenshot = button('◉', '截图', () => {
      const url = this.player.screenshot();
      if (!url) return;
      const link = document.createElement('a');
      link.href = url;
      link.download = `tesla-frame-${Date.now()}.png`;
      link.click();
    });
    screenshot.classList.add('tesla-control-optional');
    const fullscreen = button('⛶', '全屏', () => this.player.fullscreen());

    const spacer = document.createElement('span');
    spacer.className = 'tesla-control-spacer';
    this.element.append(
      this.stateLabel,
      this.playButton,
      this.stopButton,
      this.progress,
      this.time,
      spacer,
      this.muteButton,
      this.volume,
      screenshot,
      fullscreen
    );

    this.unsubscribe = this.player.on('state', () => this.refresh());
    this.timer = window.setInterval(() => this.refresh(), 250);
    this.container.addEventListener('pointermove', this.showTemporarily, { passive: true });
    this.container.addEventListener('pointerdown', this.showTemporarily, { passive: true });
    this.container.addEventListener('touchstart', this.showTemporarily, { passive: true });
    this.container.addEventListener('focusin', this.showTemporarily);
    this.container.addEventListener('keydown', this.handleKeyDown);
    this.container.addEventListener('dblclick', this.handleDoubleClick);
    if (!this.container.hasAttribute('tabindex')) this.container.tabIndex = 0;
    this.refresh();
  }

  destroy(): void {
    this.unsubscribe?.();
    if (this.timer !== undefined) clearInterval(this.timer);
    if (this.hideTimer !== undefined) clearTimeout(this.hideTimer);
    this.container.removeEventListener('pointermove', this.showTemporarily);
    this.container.removeEventListener('pointerdown', this.showTemporarily);
    this.container.removeEventListener('touchstart', this.showTemporarily);
    this.container.removeEventListener('focusin', this.showTemporarily);
    this.container.removeEventListener('keydown', this.handleKeyDown);
    this.container.removeEventListener('dblclick', this.handleDoubleClick);
    if (this.originalTabIndex === null) this.container.removeAttribute('tabindex');
    else this.container.setAttribute('tabindex', this.originalTabIndex);
    this.element.remove();
  }

  private refresh(): void {
    const state = this.player.getState();
    const stats = this.player.getStats();
    this.playButton.textContent = state === 'playing' || state === 'loading' ? '❚❚' : '▶';
    this.playButton.title = state === 'playing' || state === 'loading' ? '暂停' : '播放';
    this.stateLabel.textContent = state === 'loading' ? '加载中…' : state === 'error' ? '播放失败' : '';
    this.stateLabel.hidden = state !== 'loading' && state !== 'error';

    const duration = Number(stats.duration) || 0;
    const current = Math.max(0, Number(stats.currentTime) || 0);
    this.progress.disabled = duration <= 0;
    this.progress.max = String(Math.max(1, duration));
    if (!this.scrubbing) this.progress.value = String(Math.min(current, Math.max(1, duration)));
    if (!this.scrubbing) this.time.textContent = `${formatPlayerTime(current)} / ${formatPlayerTime(duration)}`;

    const volume = this.player.getVolume();
    if (document.activeElement !== this.volume) this.volume.value = String(volume);
    this.updateVolumeIcon(volume);
    this.stopButton.disabled = state === 'idle' || state === 'stopped' || state === 'destroyed';

    if (state === 'playing') this.scheduleHide();
    else this.show();
  }

  private updateTimePreview(): void {
    const stats = this.player.getStats();
    this.time.textContent = `${formatPlayerTime(Number(this.progress.value))} / ${formatPlayerTime(stats.duration)}`;
  }

  private toggleMute(): void {
    const current = this.player.getVolume();
    if (current > 0) {
      this.previousVolume = current;
      this.player.setVolume(0);
    } else {
      this.player.setVolume(this.previousVolume || 1);
    }
    this.refresh();
  }

  private updateVolumeIcon(value: number): void {
    this.muteButton.textContent = value <= 0 ? '🔇' : value < 0.5 ? '🔉' : '🔊';
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target?.tagName === 'INPUT' || target?.tagName === 'BUTTON') return;
    const key = event.key.toLowerCase();
    if (key === ' ' || key === 'k') {
      event.preventDefault();
      this.player.togglePlayback().catch(error => this.player.events.emit('error', error));
    } else if (key === 'm') {
      event.preventDefault();
      this.toggleMute();
    } else if (key === 'f') {
      event.preventDefault();
      this.player.fullscreen();
    } else if (key === 'arrowleft' || key === 'arrowright') {
      const stats = this.player.getStats();
      if (stats.duration > 0) {
        event.preventDefault();
        const offset = key === 'arrowleft' ? -5 : 5;
        this.player.seek(Math.max(0, Math.min(stats.duration, stats.currentTime + offset)));
      }
    }
    this.showTemporarily();
  };

  private handleDoubleClick = (event: MouseEvent): void => {
    if ((event.target as HTMLElement | null)?.closest('.tesla-control-bar')) return;
    this.player.fullscreen();
  };

  private showTemporarily = (): void => {
    this.show();
    if (this.player.getState() === 'playing') this.scheduleHide();
  };

  private show(): void {
    this.element.dataset.hidden = 'false';
    if (this.hideTimer !== undefined) {
      clearTimeout(this.hideTimer);
      this.hideTimer = undefined;
    }
  }

  private scheduleHide(): void {
    if (this.hideTimer !== undefined || this.scrubbing || this.element.contains(document.activeElement)) return;
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = undefined;
      if (this.player.getState() === 'playing' && !this.element.contains(document.activeElement)) {
        this.element.dataset.hidden = 'true';
      }
    }, 2600);
  }
}

function button(text: string, label: string, action: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = text;
  element.title = label;
  element.setAttribute('aria-label', label);
  element.addEventListener('click', action);
  return element;
}

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.tesla-control-bar{position:absolute;left:0;right:0;bottom:0;z-index:30;display:flex;align-items:center;gap:8px;min-height:52px;padding:8px max(10px,env(safe-area-inset-right)) calc(8px + env(safe-area-inset-bottom)) max(10px,env(safe-area-inset-left));background:linear-gradient(transparent,rgba(0,0,0,.9));color:#fff;transition:opacity .2s ease,transform .2s ease;font:13px/1.2 system-ui,-apple-system,Segoe UI,sans-serif}
.tesla-control-bar[data-hidden="true"]{opacity:0;transform:translateY(8px);pointer-events:none}
.tesla-control-bar button{display:grid;place-items:center;min-width:38px;height:38px;padding:0 10px;border:0;border-radius:10px;background:rgba(255,255,255,.14);color:#fff;font:600 16px/1 system-ui;cursor:pointer;backdrop-filter:blur(8px)}
.tesla-control-bar button:hover,.tesla-control-bar button:focus-visible{background:rgba(255,255,255,.25);outline:2px solid rgba(255,255,255,.65);outline-offset:1px}
.tesla-control-bar button:disabled{opacity:.4;cursor:default}
.tesla-control-primary{background:#2563eb!important}
.tesla-control-progress{flex:1 1 180px;min-width:70px;accent-color:#3b82f6}
.tesla-control-volume{width:90px;accent-color:#3b82f6}
.tesla-control-time{white-space:nowrap;font-variant-numeric:tabular-nums;text-shadow:0 1px 2px #000}
.tesla-control-spacer{flex:0 0 2px}
.tesla-control-state{position:absolute;left:50%;bottom:58px;transform:translateX(-50%);padding:7px 12px;border-radius:999px;background:rgba(0,0,0,.72);white-space:nowrap}
@media(max-width:560px){.tesla-control-bar{gap:5px;min-height:48px;padding-top:6px}.tesla-control-bar button{min-width:36px;height:36px;padding:0 8px}.tesla-control-time,.tesla-control-optional,.tesla-control-bar>button:nth-of-type(2){display:none}.tesla-control-volume{width:62px}.tesla-control-progress{flex-basis:80px}}
@media(pointer:coarse){.tesla-control-bar button{min-width:42px;height:42px}}
`;
  document.head.appendChild(style);
}
