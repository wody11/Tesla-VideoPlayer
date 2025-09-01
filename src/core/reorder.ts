export interface VideoUnit {
  ptsUs: number;
  dtsUs?: number;
  key: boolean;
  data?: ArrayBuffer;
}

export interface ReorderOptions {
  minBufferFrames: number; // 保底重排窗口帧数（例如 3-6）
}

export class ReorderBuffer {
  private buf: VideoUnit[] = [];
  private opts: ReorderOptions;
  constructor(opts: ReorderOptions) { this.opts = opts; }

  size() { return this.buf.length; }

  push(v: VideoUnit) {
    this.buf.push(v);
    // 按 PTS 排序用于呈现
    this.buf.sort((a, b) => a.ptsUs - b.ptsUs);
  }

  // 取出所有可呈现的帧：PTS <= audioTimeUs + lookAheadUs，且保留最少 minBufferFrames 作为重排缓冲
  popRenderable(audioTimeUs: number, lookAheadUs: number): VideoUnit[] {
    if (this.buf.length === 0) return [];
    const limitUs = audioTimeUs + lookAheadUs;
    // 找到满足时间的最大下标
    let idx = -1;
    for (let i = 0; i < this.buf.length; i++) {
      if (this.buf[i].ptsUs <= limitUs) idx = i; else break;
    }
    if (idx < 0) return [];
    // 保留尾部 minBufferFrames 不动，除非音频已经超过它们
    const keep = Math.max(0, this.opts.minBufferFrames);
    const cutoff = Math.min(idx + 1, Math.max(0, this.buf.length - keep));
    if (cutoff <= 0) return [];
    return this.buf.splice(0, cutoff);
  }

  dropOlderThan(thresholdPtsUs: number): number {
    const before = this.buf.length;
    this.buf = this.buf.filter(v => v.ptsUs >= thresholdPtsUs);
    return before - this.buf.length;
  }
}
