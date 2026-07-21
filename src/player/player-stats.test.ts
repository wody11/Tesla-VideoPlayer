import { PlayerStatsTracker } from './player-stats';

describe('PlayerStatsTracker', () => {
  it('keeps media sample counts separate from scoped DOM diagnostics', () => {
    const scope = {
      querySelectorAll(selector: string) {
        return { length: selector === 'video' ? 1 : 2 } as any;
      }
    };
    const stats = new PlayerStatsTracker(scope);
    stats.patch({ videoTagCount: 42, audioSampleCount: 12 });
    expect(stats.snapshot()).toMatchObject({
      videoTagCount: 42,
      audioSampleCount: 12,
      videoElementCount: 1,
      canvasCount: 2
    });
  });

  it('resets per-session counters without carrying old playback values', () => {
    const stats = new PlayerStatsTracker();
    stats.patch({ decodedFrames: 9, droppedFrames: 3, duration: 99, lastError: 'old' });
    stats.resetSession({ sourceType: 'mp4', decoderType: 'webcodecs' });
    expect(stats.snapshot()).toMatchObject({
      sourceType: 'mp4',
      decoderType: 'webcodecs',
      decodedFrames: 0,
      droppedFrames: 0,
      duration: 0,
      lastError: ''
    });
  });
});
