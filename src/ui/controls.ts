export function createControls() {
  // Skeleton for UI controls binding
  return {
    onPlay: (cb: () => void) => {},
    onPause: (cb: () => void) => {},
    onSeek: (cb: (ms: number) => void) => {},
  };
}
