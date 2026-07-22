export interface AudioTimelineInput {
  queuedMs: number;
  mediaGapMs: number;
  maxQueueMs: number;
  hasStarted: boolean;
}

export type AudioTimelineResetReason = 'none' | 'backlog' | 'timestamp-gap' | 'underrun';

export function deriveAudioStartupBufferMs(maxQueueMs: number): number {
  const normalized = Math.max(300, Math.min(5000, Number(maxQueueMs) || 1500));
  return Math.round(Math.max(80, Math.min(260, normalized * 0.12)));
}

export function decideAudioTimelineReset(input: AudioTimelineInput): AudioTimelineResetReason {
  const maxQueueMs = Math.max(300, Number(input.maxQueueMs) || 1500);
  if (input.queuedMs > Math.max(maxQueueMs * 1.6, maxQueueMs + 800)) return 'backlog';
  if (input.hasStarted && Math.abs(input.mediaGapMs) > 160) return 'timestamp-gap';
  if (input.hasStarted && input.queuedMs < -25) return 'underrun';
  return 'none';
}


export function calculateAudioStartTime(
  nowSeconds: number,
  scheduledUntilSeconds: number,
  startupBufferMs: number,
  startsNewTimeline: boolean
): number {
  const now = Math.max(0, Number(nowSeconds) || 0);
  const scheduledUntil = Math.max(0, Number(scheduledUntilSeconds) || 0);
  const leadSeconds = Math.max(0.015, (Math.max(0, Number(startupBufferMs) || 0)) / 1000);
  const timelineTarget = startsNewTimeline
    ? Math.max(scheduledUntil, now + leadSeconds)
    : scheduledUntil;
  return Math.max(now + 0.015, timelineTarget);
}
