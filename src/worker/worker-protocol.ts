// Narrow protocol between the main-thread player and Tesla's own FLV worker.
export type TeslaWorkerCommand =
  | { type: 'open-http-flv'; url: string }
  | { type: 'open-hls'; url: string; liveStartSegmentCount?: number; liveSegmentBatch?: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' };

export type TeslaWorkerEvent =
  | { type: 'stream-open' }
  | { type: 'stream-end' }
  | { type: 'video-config'; codec: string; description?: ArrayBuffer; annexb?: boolean }
  | { type: 'audio-config'; codec: string; description: ArrayBuffer; sampleRate: number; numberOfChannels: number }
  | { type: 'video-sample'; timestamp: number; duration?: number; key: boolean; data: ArrayBuffer }
  | { type: 'audio-sample'; timestamp: number; duration?: number; data: ArrayBuffer }
  | { type: 'stats'; videoTagCount: number; audioTagCount: number }
  | { type: 'log'; message: string }
  | { type: 'error'; message: string };
