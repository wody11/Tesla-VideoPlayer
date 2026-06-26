// Guardrail for the project rule that playback must never create video tags.
export function assertNoVideoElements(): number {
  return document.querySelectorAll('video').length;
}

export class NoVideoGuard {
  private observer?: MutationObserver;

  start(onViolation: (count: number) => void): void {
    this.stop();
    const check = () => {
      const count = assertNoVideoElements();
      if (count > 0) onViolation(count);
    };
    check();
    this.observer = new MutationObserver(check);
    this.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  stop(): void {
    if (this.observer) this.observer.disconnect();
    this.observer = undefined;
  }
}
