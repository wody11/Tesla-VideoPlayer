import { assertNoVideoElements, NoVideoGuard } from './no-video-guard';

describe('NoVideoGuard', () => {
  test('counts video elements only inside the supplied root', () => {
    const root = {
      querySelectorAll: jest.fn().mockReturnValue([{ tagName: 'VIDEO' }])
    } as unknown as ParentNode;

    expect(assertNoVideoElements(root)).toBe(1);
    expect(root.querySelectorAll).toHaveBeenCalledWith('video');
  });

  test('observes the supplied player container rather than the whole document', () => {
    const observe = jest.fn();
    const disconnect = jest.fn();
    const OriginalMutationObserver = globalThis.MutationObserver;
    (globalThis as any).MutationObserver = class {
      constructor(_callback: MutationCallback) {}
      observe = observe;
      disconnect = disconnect;
    };

    const root = {
      querySelectorAll: jest.fn().mockReturnValue([])
    } as unknown as ParentNode;
    const guard = new NoVideoGuard();

    try {
      guard.start(jest.fn(), root);
      expect(observe).toHaveBeenCalledWith(root, { childList: true, subtree: true });
    } finally {
      guard.stop();
      (globalThis as any).MutationObserver = OriginalMutationObserver;
    }
  });
});
