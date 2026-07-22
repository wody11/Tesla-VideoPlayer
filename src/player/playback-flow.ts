export interface VideoSampleLike {
  key: boolean;
}

export const DEFAULT_VIDEO_DECODE_QUEUE_LIMIT = 24;

export function canDecodeVideo(
  configured: boolean,
  pendingSamples: number,
  renderQueueSize: number,
  decoderQueueSize: number,
  maxRenderQueue: number,
  decoderQueueLimit = DEFAULT_VIDEO_DECODE_QUEUE_LIMIT
): boolean {
  return configured
    && pendingSamples > 0
    && renderQueueSize < maxRenderQueue
    && decoderQueueSize < decoderQueueLimit;
}

/**
 * Bounds a live-video sample queue without resuming from an undecodable delta frame.
 * The newest key frame is retained with all samples after it. If there is no key
 * frame in the retained window, the queue is cleared and playback waits for one.
 */
export function trimLiveVideoQueue<T extends VideoSampleLike>(queue: T[], maxSize: number): number {
  const limit = Math.max(1, Math.floor(maxSize));
  if (queue.length <= limit) return 0;

  const searchStart = Math.max(0, queue.length - limit);
  let keepFrom = -1;
  for (let i = queue.length - 1; i >= searchStart; i -= 1) {
    if (queue[i].key) {
      keepFrom = i;
      break;
    }
  }

  if (keepFrom < 0) {
    const dropped = queue.length;
    queue.length = 0;
    return dropped;
  }

  const dropped = keepFrom;
  queue.splice(0, keepFrom);
  return dropped;
}

export interface TimestampedSampleLike {
  timestamp: number;
  duration?: number;
}

export function trimLiveAudioQueue<T extends TimestampedSampleLike>(queue: T[], maxDurationUs: number, maxSamples = 512): number {
  const durationLimit = Math.max(100_000, Number(maxDurationUs) || 2_000_000);
  const sampleLimit = Math.max(8, Math.floor(maxSamples));
  if (queue.length <= sampleLimit) {
    const first = queue[0];
    const last = queue[queue.length - 1];
    if (!first || !last || last.timestamp - first.timestamp <= durationLimit) return 0;
  }

  let keepFrom = queue.length - 1;
  const newest = queue[queue.length - 1]?.timestamp || 0;
  while (keepFrom > 0) {
    const span = newest - queue[keepFrom - 1].timestamp;
    if (queue.length - keepFrom >= sampleLimit || span > durationLimit) break;
    keepFrom -= 1;
  }
  const dropped = keepFrom;
  if (dropped > 0) queue.splice(0, dropped);
  return dropped;
}

export function insertByTimestamp<T extends { timestamp: number }>(queue: T[], item: T): void {
  const last = queue[queue.length - 1];
  if (!last || last.timestamp <= item.timestamp) {
    queue.push(item);
    return;
  }
  let low = 0;
  let high = queue.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (queue[middle].timestamp <= item.timestamp) low = middle + 1;
    else high = middle;
  }
  queue.splice(low, 0, item);
}
