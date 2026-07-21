/*
 * Tesla-VideoPlayer is based on Jessibuca open source architecture.
 * Jessibuca is licensed under GPL-3.0. See THIRD_PARTY_NOTICES.md.
 */

export function assertNoVideoElements(root: ParentNode = document): number {
  return root.querySelectorAll('video').length;
}

export class NoVideoGuard {
  private observer?: MutationObserver;

  start(onViolation: (count: number) => void, root: ParentNode = document): void {
    this.stop();
    const check = () => {
      const count = assertNoVideoElements(root);
      if (count > 0) onViolation(count);
    };
    check();
    this.observer = new MutationObserver(check);
    this.observer.observe(root, { childList: true, subtree: true });
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = undefined;
  }
}
