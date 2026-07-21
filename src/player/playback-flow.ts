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
