import { calculateAudioStartTime, decideAudioTimelineReset, deriveAudioStartupBufferMs } from './audio-scheduling';

describe('audio scheduling', () => {
  test('uses a small startup buffer instead of the full maximum queue', () => {
    expect(deriveAudioStartupBufferMs(1500)).toBe(180);
    expect(deriveAudioStartupBufferMs(900)).toBe(108);
    expect(deriveAudioStartupBufferMs(5000)).toBe(260);
  });

  test('resets excessive backlog and timestamp discontinuities', () => {
    expect(decideAudioTimelineReset({ queuedMs: 2500, mediaGapMs: 0, maxQueueMs: 900, hasStarted: true })).toBe('backlog');
    expect(decideAudioTimelineReset({ queuedMs: 300, mediaGapMs: 240, maxQueueMs: 1500, hasStarted: true })).toBe('timestamp-gap');
  });

  test('keeps a healthy contiguous timeline', () => {
    expect(decideAudioTimelineReset({ queuedMs: 180, mediaGapMs: 4, maxQueueMs: 1500, hasStarted: true })).toBe('none');
  });

  test('reapplies startup lead after a timeline reset', () => {
    expect(calculateAudioStartTime(10, 10.024, 180, true)).toBeCloseTo(10.18);
    expect(calculateAudioStartTime(10, 10.2, 180, false)).toBe(10.2);
  });
});
