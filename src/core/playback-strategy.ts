export type PlaybackPresetName = 'low-latency' | 'balanced' | 'smooth';

export interface PlaybackStrategy {
  preset: PlaybackPresetName;
  audioMaxQueueMs: number;
  decodeBatchSize: number;
  maxRenderQueue: number;
  lateDropMs: number;
  liveStartSegmentCount: number;
  liveSegmentBatch: number;
}

export const PLAYBACK_PRESETS: Record<PlaybackPresetName, PlaybackStrategy> = {
  'low-latency': {
    preset: 'low-latency',
    audioMaxQueueMs: 900,
    decodeBatchSize: 10,
    maxRenderQueue: 80,
    lateDropMs: 160,
    liveStartSegmentCount: 1,
    liveSegmentBatch: 1
  },
  balanced: {
    preset: 'balanced',
    audioMaxQueueMs: 1500,
    decodeBatchSize: 8,
    maxRenderQueue: 120,
    lateDropMs: 240,
    liveStartSegmentCount: 1,
    liveSegmentBatch: 1
  },
  smooth: {
    preset: 'smooth',
    audioMaxQueueMs: 2600,
    decodeBatchSize: 6,
    maxRenderQueue: 180,
    lateDropMs: 420,
    liveStartSegmentCount: 2,
    liveSegmentBatch: 1
  }
};

export function resolvePlaybackStrategy(name: PlaybackPresetName): PlaybackStrategy {
  return { ...PLAYBACK_PRESETS[name] };
}
