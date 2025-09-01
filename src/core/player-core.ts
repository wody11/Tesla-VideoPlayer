/**
 * PlayerCore - 主线程播放器内核门面（骨架）
 * 负责 lifecycle、解码器管理、与 worker 通信、渲染队列。
 */

export interface PlayerCoreOptions {
  videoLookAheadMs?: number; // 预解码窗口（默认 100ms）
  canvas: HTMLCanvasElement;
  dropWindowMs?: number;     // 落后丢帧窗口（默认 200ms）
  leadWindowMs?: number;     // 超前立即绘制阈值（默认 200ms）
  maxVideoInFlight?: number; // 同时在解码器中的最大帧数（默认 8）
  maxVideoQueue?: number;    // 主线程待解码队列最大长度（默认 300）
  renderer?: '2d' | 'webgl'; // 渲染器选择，默认 WebGL（自动回退 2D）
  usePcrBeforeAudio?: boolean; // 在音频时间基建立前，是否临时用 PCR 作为视频调度时钟
  enableSoftwareFallback?: boolean; // WebCodecs 不可用或配置失败时，尝试软解回退（占位）
  stallAudioMinAheadS?: number; // 默认 0.03s
  stallNoAudioIdleMs?: number;  // 默认 500ms
  // 偏好设置（可从 localStorage 读取覆盖）
  useWebCodecs?: { video?: boolean; audio?: boolean };
  hardwareAcceleration?: 'prefer-hardware'|'prefer-software';
  audioMsePreferred?: boolean; // 仅持久化，不影响当前实现
}

export class PlayerCore {
  // 播放控制状态
  private isPlaying: boolean = false;
  private playbackRate: number = 1.0; // 当前生效速率（平滑趋近目标）
  private targetPlaybackRate: number = 1.0; // 目标速率
  private playbackRateTimer?: number; // 平滑调节定时器
  private eventListeners: { [key: string]: Function[] } = {};
  private _applyPlaybackRateToSources() {
    try {
      for (const s of this.audioSources) {
        try { ((s as any).playbackRate && (s as any).playbackRate.value !== undefined) && (((s as any).playbackRate.value = this.playbackRate)); } catch {}
      }
    } catch {}
  }

  // 事件注册
  on(event: string, cb: Function) {
    if (!this.eventListeners[event]) this.eventListeners[event] = [];
    this.eventListeners[event].push(cb);
  }
  off(event: string, cb: Function) {
    const arr = this.eventListeners[event];
    if (!arr) return;
    const i = arr.indexOf(cb);
    if (i >= 0) arr.splice(i, 1);
  }
  once(event: string, cb: Function) {
    const wrap = (...args: any[]) => { try { cb(...args); } finally { this.off(event, wrap); } };
    this.on(event, wrap);
  }

  // 事件分发
  private emit(event: string, ...args: any[]) {
    (this.eventListeners[event]||[]).forEach(fn => { try { fn(...args); } catch(e){} });
  }
  // 检查 WebCodecs 支持
  private isWebCodecsSupported(): boolean {
    return typeof (window as any).VideoDecoder !== 'undefined' && typeof (window as any).AudioDecoder !== 'undefined';
  }

  // 软解接口占位（WASM）
  private decodeVideoWASM(chunk: any) {
    // TODO: 调用 WASM 解码库（如 ffmpeg.wasm），返回解码后帧
    console.warn('WASM软解未实现，当前仅为接口占位');
  }

  private decodeAudioWASM(chunk: any) {
    // TODO: 调用 WASM 解码库，返回解码后 PCM
    console.warn('WASM软解未实现，当前仅为接口占位');
  }
  private generationId: number = 0;
  // Timebase helpers: we use microseconds (us) internally for sample timestamps
  private US_TO_S = (us: number) => us / 1e6;
  private MS_TO_US = (ms: number) => ms * 1000;
  // 后备渲染定时器间隔（ms）——将定为 16ms（约 60fps 的后备）
  private BACKUP_RENDER_INTERVAL_MS: number = 16;
  private __lookAheadUs: number = 80_000; // 80ms，适当增加前瞻，缓解音频抖动
  private __dropWindowUs: number = 120_000; // 120ms，降低卡顿
  // 视频绘制“超前阈值”，当视频帧相对音频主钟超前超过此值时，选择不再等待直接绘制一次（以保证画面活性）
  // 注意：这是“可见性优先”的策略，若严格追求唇同步，可将其调小直至 0
  private __leadWindowUs: number = 200_000; // 200ms
  // 动态 lead 策略：VOD 默认更严格，LIVE 更宽松；首屏引导期允许更宽松后收紧
  private __leadWindowDefaultVodUs: number = 100_000; // 100ms
  private __leadWindowDefaultLiveUs: number = 200_000; // 200ms
  private bootstrapPhaseUntilPerfMs?: number; // performance.now() 到此时间视为首屏引导期
  private __maxVideoInFlight = 6; // 初始 in-flight 限制更紧
  private __maxVideoQueue = 180;  // 初始排队更短，减小首段积压
  // 启动期引导：首个关键帧后，在一定窗口内（us）额外喂入少量 delta 帧，尽快稳态
  private __bootstrapLimitUs: number = 500_000; // 500ms
  private __bootstrapMax: number = 20; // 最多 20 帧
  private stallMinAudioAheadS: number = 0.03;
  private stallNoAudioIdleMs: number = 500;
  private normalizeTsToUs(ts: number) {
    // 启发式：> ~50 分钟（3e9）视为 90kHz tick，转换为微秒；否则按微秒处理
    try {
  if (!Number.isFinite(ts)) return ts;
  return (ts > 3e9) ? Math.round(ts * (1e6 / 90000)) : Math.round(ts);
    } catch { return ts; }
  }

  // HLS 变体选择状态与持久化
  private lastHlsMasterUrl?: string;
  private currentHlsVariantIndex?: number;

  // Inline AudioWorkletProcessor source for tiny time-stretch smoothing.
  private TIME_STRETCH_WORKLET_SOURCE = `
  class TimeStretchProcessor extends AudioWorkletProcessor {
    constructor() { super(); this._channels = 2; this._sampleRate = sampleRate; this._buffers = []; this._readPos = 0; this._applyRate = 1.0; this.port.onmessage = (ev)=>{ const m = ev.data||{}; if (m.type==='config'){ if(typeof m.channels==='number') this._channels=m.channels; if(typeof m.sampleRate==='number') this._sampleRate=m.sampleRate; if(typeof m.rate==='number') this._applyRate=m.rate; } else if(m.type==='pcm'){ try{ const chs = m.channelCount||this._channels; for(let c=0;c<chs;c++){ const buf = new Float32Array(m.data[c]); this._buffers.push(buf); } }catch(e){} } }; }
    process(inputs, outputs) { const out = outputs[0]; const frames = out[0].length; for (let ch=0; ch<out.length; ch++){ const outCh = out[ch]; for(let i=0;i<frames;i++){ let val = 0.0; if (this._buffers.length){ const b = this._buffers[0]; if (this._readPos < b.length){ const idx = this._readPos; const i0 = Math.floor(idx); const frac = idx - i0; const v0 = b[i0]||0; const v1 = b[i0+1]||0; val = v0*(1-frac)+v1*frac; this._readPos += this._applyRate; } if (this._buffers.length && this._readPos >= this._buffers[0].length){ this._readPos = this._readPos - this._buffers[0].length; this._buffers.shift(); } } outCh[i] = val; } } return true; }
  }
  registerProcessor('time-stretch-processor', TimeStretchProcessor);
  `;

  // 工具：检测 AnnexB 起始码
  private _isAnnexB(buf: ArrayBuffer): boolean {
    try {
      const u = new Uint8Array(buf);
      if (u.length < 4) return false;
      // 支持 00 00 01 或 00 00 00 01
      return (u[0] === 0 && u[1] === 0 && ((u[2] === 1) || (u[2] === 0 && u[3] === 1)));
    } catch { return false; }
  }

  // 工具：将 AVCC（自适应 1/2/4 字节长度前缀）转换为 AnnexB（起始码）
  private _avccToAnnexB(buf: ArrayBuffer): ArrayBuffer {
    try {
      const u8 = new Uint8Array(buf);
      if (u8.length < 1) return buf;
      const tryParse = (lenSize: 1 | 2 | 4): ArrayBuffer | null => {
        const chunks: Uint8Array[] = [];
        let off = 0;
        while (off + lenSize <= u8.length) {
          let len = 0;
          if (lenSize === 4) {
            len = (u8[off] << 24) | (u8[off + 1] << 16) | (u8[off + 2] << 8) | (u8[off + 3]);
          } else if (lenSize === 2) {
            len = (u8[off] << 8) | (u8[off + 1]);
          } else { // 1
            len = u8[off];
          }
          off += lenSize;
          if (len <= 0 || off + len > u8.length) return null;
          chunks.push(new Uint8Array([0, 0, 0, 1]));
          chunks.push(u8.subarray(off, off + len));
          off += len;
        }
        if (off !== u8.length || chunks.length === 0) return null;
        let total = 0; for (const c of chunks) total += c.length;
        const out = new Uint8Array(total);
        let p = 0; for (const c of chunks) { out.set(c, p); p += c.length; }
        return out.buffer;
      };
      return tryParse(4) || tryParse(2) || tryParse(1) || buf;
    } catch { return buf; }
  }

  // 缓存最近的 SPS/PPS（AnnexB NAL 单元，包含起始码）
  private _lastSpsUnits: Uint8Array[] = [];
  private _lastPpsUnits: Uint8Array[] = [];

  // 扫描 AnnexB，缓存 SPS/PPS，返回是否检测到
  private _scanAndCacheSpsPpsFromAnnexB(buf: ArrayBuffer): { hasSps: boolean; hasPps: boolean } {
    try {
      const u8 = new Uint8Array(buf);
      const starts: number[] = [];
      // 找到所有起始码位置
      for (let i = 0; i + 3 < u8.length; i++) {
        if (u8[i] === 0 && u8[i + 1] === 0 && ((u8[i + 2] === 1) || (u8[i + 2] === 0 && u8[i + 3] === 1))) {
          starts.push(i);
          if (u8[i + 2] === 1) i += 2; else i += 3; // 跳过起始码长度
        }
      }
      if (starts.length === 0) return { hasSps: false, hasPps: false };
      // 计算每个 NAL 的边界
      const bounds: Array<{ off: number; len: number; type: number }> = [];
      for (let si = 0; si < starts.length; si++) {
        const off = starts[si];
        const scLen = (u8[off + 2] === 1) ? 3 : 4;
        const payloadStart = off + scLen;
        const next = (si + 1 < starts.length) ? starts[si + 1] : u8.length;
        const len = next - off;
        if (payloadStart < u8.length) {
          const nalHeader = u8[payloadStart];
          const nalType = nalHeader & 0x1f; // H.264
          bounds.push({ off, len, type: nalType });
        }
      }
      let hasSps = false, hasPps = false;
      for (const b of bounds) {
        if (b.type === 7) { hasSps = true; this._lastSpsUnits = [u8.subarray(b.off, b.off + b.len)]; }
        if (b.type === 8) { hasPps = true; this._lastPpsUnits = [u8.subarray(b.off, b.off + b.len)]; }
      }
      return { hasSps, hasPps };
    } catch { return { hasSps: false, hasPps: false }; }
  }

  // 若关键帧缺少 SPS/PPS，则用缓存注入（AnnexB 格式）
  private _ensureSpsPpsForKeyAnnexB(buf: ArrayBuffer): ArrayBuffer {
    try {
      const found = this._scanAndCacheSpsPpsFromAnnexB(buf);
      if (found.hasSps && found.hasPps) return buf;
      const needSps = !found.hasSps && this._lastSpsUnits.length > 0;
      const needPps = !found.hasPps && this._lastPpsUnits.length > 0;
      if (!needSps && !needPps) return buf;
      const u8 = new Uint8Array(buf);
      let extraLen = 0;
      if (needSps) for (const s of this._lastSpsUnits) extraLen += s.length;
      if (needPps) for (const p of this._lastPpsUnits) extraLen += p.length;
      const out = new Uint8Array(extraLen + u8.length);
      let p = 0;
      if (needSps) { for (const s of this._lastSpsUnits) { out.set(s, p); p += s.length; } }
      if (needPps) { for (const q of this._lastPpsUnits) { out.set(q, p); p += q.length; } }
      out.set(u8, p);
      return out.buffer;
    } catch { return buf; }
  }

  // 从 avcC extradata 提取 SPS/PPS 并缓存（便于后续 AnnexB 注入）
  private _cacheSpsPpsFromAvcC(desc: ArrayBuffer) {
    try {
      const u = new Uint8Array(desc);
      if (u.length < 7) return;
      let off = 0;
      // 跳过头部 5 字节：version, profile, compat, level, lengthSizeMinusOne
      off = 5;
      const numSps = u[off++] & 0x1f;
      const spsUnits: Uint8Array[] = [];
      for (let i = 0; i < numSps; i++) {
        if (off + 2 > u.length) return;
        const len = (u[off] << 8) | u[off + 1]; off += 2;
        if (off + len > u.length) return;
        // 组装 AnnexB：起始码 + NAL
        const out = new Uint8Array(4 + len);
        out.set([0,0,0,1], 0);
        out.set(u.subarray(off, off + len), 4);
        spsUnits.push(out);
        off += len;
      }
      if (off >= u.length) { this._lastSpsUnits = spsUnits; return; }
      const numPps = u[off++];
      const ppsUnits: Uint8Array[] = [];
      for (let i = 0; i < numPps; i++) {
        if (off + 2 > u.length) break;
        const len = (u[off] << 8) | u[off + 1]; off += 2;
        if (off + len > u.length) break;
        const out = new Uint8Array(4 + len);
        out.set([0,0,0,1], 0);
        out.set(u.subarray(off, off + len), 4);
        ppsUnits.push(out);
        off += len;
      }
      if (spsUnits.length) this._lastSpsUnits = spsUnits;
      if (ppsUnits.length) this._lastPpsUnits = ppsUnits;
    } catch { /* ignore */ }
  }

  // Audio scheduling state
  private audioBasePtsUs?: number; // first audio sample PTS in us
  private audioBaseTime?: number; // corresponding AudioContext.currentTime (s)
  // 统一媒体时间轴纪元（谁先来以谁为 0 点）
  private mediaEpochUs?: number;
  // 记录当前音频配置用于热重配
  private audioConfiguredSampleRate?: number;
  private audioConfiguredChannels?: number;
  private audioLastCodec?: string;
  private audioLastDescription?: ArrayBuffer | null;
  // Time-stretch & smoothing
  private timeStretchEnabled: boolean = true; // enable small ±1% smoothing
  private audioWorkletNode?: any;
  private _timeStretchInitPromise?: Promise<void> | null = null;
  private audioSampleRateMismatchCount: number = 0;
  private audioChannelReconfigCount: number = 0;
  // 可选：在音频时间基未建立前，用 PCR 作为临时时钟
  private pcrBasePtsUs?: number;
  private pcrBaseTime?: number; // performance.now() 秒
  private usePcrBeforeAudio: boolean = false;
  // 进一步回退：若既无音频也无 PCR，则基于首个视频样本建立墙钟映射
  private videoBasePtsUs?: number;
  private videoBaseTime?: number; // performance.now() 秒
  // 视频格式/配置观测与热重配标志
  private videoCodec?: string;
  private videoDescAttached: boolean = false;
  private firstVideoSeen: boolean = false;
  private annexbDetected: boolean = false;
  private lastVideoPtsUs?: number; // 最近绘制的视频帧PTS，用于去重/倒退丢弃
  // 偏好设置（持久化于 KIT_PLAYER_*）
  private prefUseWcVideo: boolean = true;
  private prefUseWcAudio: boolean = true;
  private prefHardwareAccel: 'prefer-hardware'|'prefer-software' = 'prefer-hardware';
  private prefAudioMse: boolean = false;
  // 连续时间轴（跨 discontinuity/seek 维持 UI 连续）；单位：微秒
  private continuousTimeline: boolean = true;
  private timelineOffsetUs: number = 0;
  // 已计划播放的音频节点，便于在 seek/stop/discontinuity 时统一停止
  private audioSources: Set<AudioBufferSourceNode> = new Set();

  private _registerAudioSource(src: AudioBufferSourceNode) {
    try {
      this.audioSources.add(src);
      const cleanup = () => { try { src.disconnect(); } catch {} this.audioSources.delete(src); };
      // ended 事件在部分实现中可用；若不可用也不致命
      (src as any).addEventListener?.('ended', cleanup);
      // 兜底：在 stop/seek/discontinuity 中统一清理
    } catch {}
  }

  private _stopAllAudioSources() {
    try {
      for (const s of Array.from(this.audioSources)) {
        try { s.stop(); } catch {}
        try { s.disconnect(); } catch {}
        this.audioSources.delete(s);
      }
    } catch {}
  }
  // 视频黑屏检测（当音频活跃但视频长时间未更新时触发）
  private noVideoTimer?: number;
  private noVideoEmitted: boolean = false;
  private _startNoVideoWatcher() {
    try {
      if (this.noVideoTimer) return;
      this.noVideoTimer = window.setInterval(() => {
        try {
          // 若音频基准已建立且最近绘制的视频 pts 未更新超过阈值
          if (this.audioBasePtsUs !== undefined && this.audioBaseTime !== undefined) {
            const nowS = this.audioCtx ? this.audioCtx.currentTime : (performance.now() / 1000);
            const nowMediaUs = this.audioBasePtsUs + Math.max(0, (nowS - this.audioBaseTime)) * 1e6;
            if (this.lastVideoPtsUs === undefined || (nowMediaUs - this.lastVideoPtsUs) > 3_000_000) {
              if (!this.noVideoEmitted) { this.noVideoEmitted = true; try { this.emit('no-video'); } catch {} }
            } else {
              if (this.noVideoEmitted) { this.noVideoEmitted = false; try { this.emit('video-resumed'); } catch {} }
            }
          }
        } catch {}
      }, 800);
    } catch {}
  }
  private _stopNoVideoWatcher() {
    try { if (this.noVideoTimer) { window.clearInterval(this.noVideoTimer); this.noVideoTimer = undefined; } } catch {}
  }
  // 计算当前音频主钟对应的 PTS（us）。若基准未建立，返回 undefined
  private _getAudioNowUs(): number | undefined {
    if (!this.audioCtx || this.audioBasePtsUs === undefined || this.audioBaseTime === undefined) return undefined;
    const nowS = this.audioCtx.currentTime;
    const deltaS = nowS - this.audioBaseTime;
  return this.audioBasePtsUs + Math.max(0, deltaS) * 1e6;
  }

  // 轻量：尝试解锁 AudioContext（在需要时调用，不阻塞主流程）
  private _ensureAudioUnlocked(): void {
    try {
      if (!this.audioCtx) return;
      const st = String((this.audioCtx.state as any) || '');
      if (st === 'suspended' || st === 'interrupted') {
        this.audioCtx.resume().catch(()=>{});
      }
    } catch {}
  }

  // 额外的 resume 兜底：立即尝试并在短延迟后重试几次，覆盖部分平台首次 resume 未生效的情况
  private _resumeAudioContextWithRetries() {
    try {
      if (!this.audioCtx) return;
      const tryResume = () => { try { this.audioCtx!.resume().catch(()=>{}); } catch {} };
      tryResume();
      try { setTimeout(tryResume, 60); } catch {}
      try { setTimeout(tryResume, 300); } catch {}
    } catch {}
  }

  // 平滑调节当前播放速率，逐步靠近 targetPlaybackRate
  private _ensurePlaybackRateTimer(): void {
    try {
      if (this.playbackRateTimer) return;
      this.playbackRateTimer = window.setInterval(() => {
        const step = 0.01;
        if (Math.abs(this.playbackRate - this.targetPlaybackRate) <= step) {
          this.playbackRate = this.targetPlaybackRate;
          if (this.playbackRateTimer) { window.clearInterval(this.playbackRateTimer); this.playbackRateTimer = undefined; }
          this._applyPlaybackRateToSources();
          return;
        }
        if (this.playbackRate < this.targetPlaybackRate) this.playbackRate = Math.min(this.targetPlaybackRate, this.playbackRate + step);
        else this.playbackRate = Math.max(this.targetPlaybackRate, this.playbackRate - step);
        this._applyPlaybackRateToSources();
      }, 50);
    } catch {}
  }

  // 统一获取当前播放时钟（优先音频，其次可选 PCR）
  private _getClockNowUs(): number | undefined {
    const a = this._getAudioNowUs();
    if (a !== undefined) return a;
  if (this.usePcrBeforeAudio && this.pcrBasePtsUs !== undefined && this.pcrBaseTime !== undefined) {
    const nowS = performance.now() / 1000;
  const deltaS = nowS - this.pcrBaseTime;
  return this.pcrBasePtsUs + Math.max(0, deltaS) * 1e6;
    }
    if (this.videoBasePtsUs !== undefined && this.videoBaseTime !== undefined) {
    const nowS = performance.now() / 1000;
  const deltaS = nowS - this.videoBaseTime;
  return this.videoBasePtsUs + Math.max(0, deltaS) * 1e6;
    }
    return undefined;
  }

  // 基于音频主钟驱动视频解码（按 DTS/PTS 队列），输出重排交给 VideoDecoder
  private _renderVideoFrame() {
  if (!this.videoDecoder) { try { if ((window as any).__DEMO_DEBUG) console.debug('[v] no decoder'); } catch {} return; }
  if (this.videoDecodeQueue.length === 0) { try { if ((window as any).__DEMO_DEBUG) console.debug('[v] queue empty'); } catch {} return; }
  try { if ((window as any).__DEMO_DEBUG) console.debug('[v] queue size=', this.videoDecodeQueue.length, 'readyForDeltas=', this.videoReadyForDeltas); } catch {}
  const audioNowUs = this._getClockNowUs();
  if (audioNowUs === undefined) {
      // 尚未建立任何时钟：尝试优先送入首个关键帧，尽快出画
      const idx = this.videoDecodeQueue.findIndex(x => x.key);
      if (idx >= 0) {
        const firstK = this.videoDecodeQueue.splice(idx, 1)[0];
        try {
                    const tsSafe = Math.max(0, Number(firstK.ts) || 0);
          // 确保送入的是 AnnexB：若为 AVCC 则转换
          let payload = firstK.data;
          if (!this._isAnnexB(payload)) payload = this._avccToAnnexB(payload);
          // 若为关键帧，缺失参数集则从缓存注入 SPS/PPS
          try { payload = this._ensureSpsPpsForKeyAnnexB(payload); } catch {}
          const init: any = { type: 'key', timestamp: tsSafe, data: payload };
          if (typeof firstK.dur === 'number' && firstK.dur > 0) init.duration = Number(firstK.dur) || undefined;
          const chunk = new (window as any).EncodedVideoChunk(init);
      if ((window as any).__DEMO_DEBUG) { try { console.debug('[feed] early key -> ts(us)=', tsSafe); } catch {} }
  this.videoDecoder.decode(chunk);
  try { this._markActivity(); } catch {}
      // 一旦送入关键帧，允许后续 delta 帧进入，避免解码器饿死
      this.videoReadyForDeltas = true;

          // 额外引导：在关键帧之后解码少量相邻 delta（<=200ms 或最多 8 帧），帮助尽快进入稳态
          const limitUs = tsSafe + this.__bootstrapLimitUs;
          let fed = 0;
          for (let i = 0; i < this.videoDecodeQueue.length && fed < this.__bootstrapMax; ) {
            const n = this.videoDecodeQueue[i];
            if ((n.dts ?? n.ts) <= limitUs && !n.key) {
              this.videoDecodeQueue.splice(i, 1);
              try {
                const nts = Math.max(0, Number(n.ts) || 0);
                // 同样保证 AnnexB
                let npayload = n.data;
                if (!this._isAnnexB(npayload)) npayload = this._avccToAnnexB(npayload);
                const ninit: any = { type: 'delta', timestamp: nts, data: npayload };
                if (typeof n.dur === 'number' && n.dur > 0) ninit.duration = Number(n.dur) || undefined;
                const nchunk = new (window as any).EncodedVideoChunk(ninit);
                if ((window as any).__DEMO_DEBUG) { try { console.debug('[feed] bootstrap delta ts(us)=', nts); } catch {} }
                this.videoDecoder.decode(nchunk);
                try { this._markActivity(); } catch {}
                fed++;
              } catch {}
            } else { i++; }
          }
        } catch {}
      }
      return;
    }

    // 1) 丢弃严重落后的帧（按 PTS 比较）
    const dropBeforeUs = audioNowUs - this.__dropWindowUs;
    if (this.videoDecodeQueue.length > 0) {
      let dropped = 0;
      while (this.videoDecodeQueue.length > 0) {
        const head = this.videoDecodeQueue[0];
        const headPtsUs = head.ts;
        if (headPtsUs < dropBeforeUs && this.videoDecodeQueue.length > 2) {
          this.videoDecodeQueue.shift();
          dropped++; this.stats.framesDropped++;
        } else {
          break;
        }
      }
      if (dropped > 0) {
        // 可选：上报丢帧统计
      }
    }

    // 2) 预解码：按 DTS 顺序尽量把解码队列喂满（避免 B 帧引用阻塞），用 in-flight 数限制控制前瞻深度
    // 控制解码排队深度，避免无穷积压。多数实现提供 decodeQueueSize。
  const vdec: any = this.videoDecoder as any;
  const maxInFlight = this.__maxVideoInFlight;
  while (this.videoDecodeQueue.length > 0 && ((vdec.decodeQueueSize ?? 0) < maxInFlight)) {
      // 目标驱动：若有音频主钟，计算 desiredPts 并从队列中就近取一帧以减少抖动
      let idxToFeed = 0;
      if (audioNowUs !== undefined) {
        try {
          // 使用 lead window 作为目标偏移（更注重可见性与唇动对齐）
          const desired = audioNowUs + this.__leadWindowUs;
          this.targetNextFramePtsUs = desired;
          // 在队列前 N 项内寻找最接近 desired（优先 >= desired，若无则取最接近的一项）
          const scanN = Math.min(32, this.videoDecodeQueue.length);
          let bestIdx = -1; let bestScore = Number.POSITIVE_INFINITY;
          for (let i = 0; i < scanN; i++) {
            const item = this.videoDecodeQueue[i];
            // 跳过未就绪的 delta
            if (!this.videoReadyForDeltas && !item.key) continue;
            const ts = Number(item.ts) || 0;
            // 惩罚过早的帧（远小于 desired）以优先选择 >= desired
            const score = (ts >= desired) ? (ts - desired) : (desired - ts) + 1e6;
            if (score < bestScore) { bestScore = score; bestIdx = i; }
            // 早到并非常接近，则可以停止搜索
            if (bestScore === 0) break;
          }
          if (bestIdx >= 0) idxToFeed = bestIdx; else idxToFeed = 0;
        } catch { idxToFeed = 0; }
      } else {
        // 无音频时仍保留原始策略（优先 key）
        idxToFeed = 0;
      }

      const next = this.videoDecodeQueue.splice(idxToFeed, 1)[0];
      try {
        if (!this.videoReadyForDeltas && !next.key) {
          // 丢弃或放回队列头（此处选择丢弃以避免死循环）
          continue;
        }
        // 控制预解码窗口：若该帧远超 audio 主钟前瞻，则放回并等待
  if (audioNowUs !== undefined && next.ts > audioNowUs + this.__leadWindowUs) {
          // 放回队列头（保持顺序）
          this.videoDecodeQueue.unshift(next);
          break;
        }
        const tsSafe = Math.max(0, Number(next.ts) || 0);
        let payload = next.data;
        if (!this._isAnnexB(payload)) payload = this._avccToAnnexB(payload);
        if (next.key) { try { payload = this._ensureSpsPpsForKeyAnnexB(payload); } catch {} }
        const init: any = { type: next.key ? 'key' : 'delta', timestamp: tsSafe, data: payload };
        if (typeof next.dur === 'number' && next.dur > 0) init.duration = Number(next.dur) || undefined;
        const chunk = new (window as any).EncodedVideoChunk(init);
        if ((window as any).__DEMO_DEBUG) { try { console.debug('[feed]', init.type, 'ts(us)=', tsSafe, 'idx=', idxToFeed); } catch {} }
        this.videoDecoder.decode(chunk);
        try { this._markActivity(); } catch {}
        if (next.key) this.videoReadyForDeltas = true;
      } catch (e) { /* 解码错误时忽略该帧 */ }
    }
  }
  private canvas: HTMLCanvasElement;
  private renderer2D?: any;
  private worker?: Worker;
  private videoDecoder?: any;
  private videoReadyForDeltas: boolean = false;
  private firstVideoSampleAt?: number;
  private keyWaitTimer?: number;
  private videoDecodeErrorStreak: number = 0;
  // 可配置：等待关键帧的阈值（毫秒），若在此期间未见到 key，则向 worker 请求定位
  private keyWaitMs: number = 80; // 推荐在 50..100ms
  // 可配置：连续视频解码错误阈值，达到后触发请求 key（快速跳过坏帧）
  private decodeErrorThreshold: number = 5;
  private enableSoftwareFallback: boolean = false;
  private softwareVideoActive: boolean = false;
  private softwareAudioActive: boolean = false;
  // 解码队列：按解码顺序（DTS 优先，缺失时回退 PTS）排列，仅存待送入解码器的样本
  private videoDecodeQueue: Array<{ ts: number; dts?: number; key: boolean; data: ArrayBuffer; dur?: number }> = [];
  private renderTimer?: number;
  private renderRafId?: number;
  // 由主钟计算的期望下一个视频帧 PTS（us），用于就近取帧策略
  private targetNextFramePtsUs?: number | undefined;
  private audioDecoder?: any;
  private audioConfigured: boolean = false;
  private audioCtx?: AudioContext;
  private audioQueue: any[] = [];
  private lastSource?: { kind: 'hls'|'flv'|'mp4-url'|'mp4-init'; url?: string; buffer?: ArrayBuffer };
  private lastWasPlaying: boolean = false;
  private lastHlsSeq?: number;
  // 简单运行指标
  private stats = { framesDrawn: 0, framesDropped: 0 };
  // 可观察的 KPI
  private kpi = {
    firstFrameTimeMs: undefined as number | undefined,
    rebufferCount: 0,
    rebufferDurationMs: 0,
    driftSamplesUs: [] as number[], // 用于计算 p50/p95
  // 当 AudioDecoder 失败时尝试使用 AudioContext.decodeAudioData 软解的次数
  softAudioFallbacks: 0,
    decodeErrors: 0,
    abrSwitches: 0,
    lastRebufferStartMs: undefined as number | undefined,
  };
  private _driftPercentile(p: number) {
    try {
      const a = Array.isArray(this.kpi.driftSamplesUs) ? this.kpi.driftSamplesUs.slice().sort((x,y)=>x-y) : [];
      if (a.length === 0) return 0;
      const idx = Math.min(a.length-1, Math.max(0, Math.floor((p/100) * a.length)));
      return a[idx];
    } catch { return 0; }
  }
  private statsTimer?: number;
  private timeEventTimer?: number;
  private mediaDurationMs?: number; // VOD 总时长（来自 worker 或 MP4 信息）
  private gainNode?: GainNode;
  private muted: boolean = false;
  private volume: number = 1;
  // 缓冲/卡顿检测：跟踪音频已调度的最远结束时间（秒）与最近活动时间（毫秒）
  private audioScheduledUntilS: number = 0;
  private lastActivityTsMs: number = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  private stallTimer?: number;
  private lastBufferingState: boolean = false;

  constructor(opts: PlayerCoreOptions) {
  this.canvas = opts.canvas;
  // 默认启用 PCR 作为临时时钟（可被 opts 覆盖）
  this.usePcrBeforeAudio = (typeof opts.usePcrBeforeAudio === 'boolean') ? opts.usePcrBeforeAudio : true;
  this.enableSoftwareFallback = !!opts.enableSoftwareFallback;
  if (typeof opts.videoLookAheadMs === 'number') this.__lookAheadUs = this.MS_TO_US(opts.videoLookAheadMs);
  if (typeof opts.dropWindowMs === 'number') this.__dropWindowUs = this.MS_TO_US(opts.dropWindowMs);
  if (typeof opts.leadWindowMs === 'number') this.__leadWindowUs = this.MS_TO_US(opts.leadWindowMs);
  else {
    // 根据 VOD/LIVE 缺省值在会话启动后更新（mediaDurationMs 未知前用较宽松 live 值）
    this.__leadWindowUs = this.__leadWindowDefaultLiveUs;
  }
  if (typeof opts.maxVideoInFlight === 'number') this.__maxVideoInFlight = Math.max(1, Math.floor(opts.maxVideoInFlight));
  if (typeof opts.maxVideoQueue === 'number') this.__maxVideoQueue = Math.max(30, Math.floor(opts.maxVideoQueue));
  if (typeof opts.stallAudioMinAheadS === 'number') this.stallMinAudioAheadS = Math.max(0, Number(opts.stallAudioMinAheadS));
  if (typeof opts.stallNoAudioIdleMs === 'number') this.stallNoAudioIdleMs = Math.max(0, Math.floor(opts.stallNoAudioIdleMs));
    try {
  const want = opts.renderer || 'webgl';
      if (want === 'webgl') {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const ModGL = require('./renderer-webgl');
          this.renderer2D = new ModGL.RendererWebGL(this.canvas);
        } catch { /* fallback to 2D */
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const Mod2D = require('./renderer-2d');
          this.renderer2D = new Mod2D.Renderer2D(this.canvas);
        }
      } else {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Mod2D = require('./renderer-2d');
        this.renderer2D = new Mod2D.Renderer2D(this.canvas);
      }
    } catch { /* ignore if module system differs */ }
    // 周期性输出运行指标（仅在 __DEMO_DEBUG 时启用）
  try {
      if (!this.statsTimer) this.statsTimer = window.setInterval(() => {
        const payload = this.getStats();
        // 控制台可选输出
        if ((window as any).__DEMO_DEBUG) {
          try { console.debug('[stats]', payload); } catch {}
        }
        // 向外抛出，给 UI 订阅
        try { this.emit('stats', payload); } catch {}
      }, 1000);
    } catch {}
  // 兼容 UI：周期性抛出当前播放时间（ms）
  try {
      if (!this.timeEventTimer) this.timeEventTimer = window.setInterval(() => {
        try {
          const now = this.getCurrentTimeMs();
          if (typeof now === 'number') this.emit('time', now);
        } catch {}
      }, 250);
    } catch {}
  // 启动卡顿/缓冲状态监测
  this._ensureStallMonitor();
  // 轻量用户手势解锁音频（一次性）
  try {
    const el = this.canvas as any;
    if (el && !(el as any).__unlockHooked) {
      const unlock = () => { try { this._ensureAudioUnlocked(); } catch {} };
      el.addEventListener('pointerdown', unlock, { passive: true });
      el.addEventListener('click', unlock, { passive: true });
      (el as any).__unlockHooked = true;
      (el as any).__unlockHandler = unlock;
    }
  } catch {}
  // 页面可见性自适应：隐藏时降低渲染频率，显示时恢复
  try {
    const visHandler = () => {
      try {
        const hidden = (document as any).hidden;
        if (hidden) {
          if (this.renderTimer) { window.clearInterval(this.renderTimer); this.renderTimer = undefined; }
          this.renderTimer = window.setInterval(() => this._renderVideoFrame(), 100);
        } else {
          if (this.renderTimer) { window.clearInterval(this.renderTimer); this.renderTimer = undefined; }
          this.renderTimer = window.setInterval(() => this._renderVideoFrame(), this.BACKUP_RENDER_INTERVAL_MS);
        }
      } catch {}
    };
    if (!(window as any).__pc_vis_hooked) {
      document.addEventListener('visibilitychange', visHandler);
      (window as any).__pc_vis_hooked = true;
      (window as any).__pc_vis_handler = visHandler;
    }
  } catch {}
  // 读取/合并偏好设置（localStorage <- opts 覆盖）
  try {
    const ls = (typeof window !== 'undefined' ? window.localStorage : null);
    const readBool = (k: string, d: boolean) => { try { const v = ls?.getItem(k); if (v === null || v === undefined) return d; return v === '1' || v === 'true'; } catch { return d; } };
    const readStr = (k: string, d: string) => { try { const v = ls?.getItem(k); return (v ?? d) as string; } catch { return d; } };
    this.prefUseWcVideo = (opts.useWebCodecs?.video ?? readBool('KIT_PLAYER_USE_WEBCODECS_VIDEO', true));
    this.prefUseWcAudio = (opts.useWebCodecs?.audio ?? readBool('KIT_PLAYER_USE_WEBCODECS_AUDIO', true));
    this.prefHardwareAccel = (opts.hardwareAcceleration ?? (readStr('KIT_PLAYER_HARDWARE_ACCEL', 'prefer-hardware') as any));
    if (this.prefHardwareAccel !== 'prefer-hardware' && this.prefHardwareAccel !== 'prefer-software') this.prefHardwareAccel = 'prefer-hardware';
    this.prefAudioMse = (typeof opts.audioMsePreferred === 'boolean' ? opts.audioMsePreferred : readBool('KIT_PLAYER_AUDIO_MSE', false));
    // 写回一次，便于 UI 读取
    ls?.setItem('KIT_PLAYER_USE_WEBCODECS_VIDEO', this.prefUseWcVideo ? '1' : '0');
    ls?.setItem('KIT_PLAYER_USE_WEBCODECS_AUDIO', this.prefUseWcAudio ? '1' : '0');
    ls?.setItem('KIT_PLAYER_HARDWARE_ACCEL', this.prefHardwareAccel);
    ls?.setItem('KIT_PLAYER_AUDIO_MSE', this.prefAudioMse ? '1' : '0');
  } catch {}
  }

  // 请求 worker 帮助定位下一个关键帧（封装用于复用）
  private _requestKeyFromWorker() {
    try {
      if (!this.worker) return;
      this.worker.postMessage({ type: 'requestKey', generationId: this.generationId });
      try { if ((window as any).__DEMO_DEBUG) console.warn('[key] requested next key from worker (via helper)'); } catch {}
    } catch (e) { try { if ((window as any).__DEMO_DEBUG) console.warn('[key] request failed', e); } catch {} }
  }

  // 外部 API：设置 key-wait 毫秒阈值
  setKeyWaitMs(ms: number) { this.keyWaitMs = Math.max(20, Math.floor(Number(ms) || 0)); }
  // 外部 API：设置连续解码错误阈值
  setDecodeErrorThreshold(n: number) { this.decodeErrorThreshold = Math.max(1, Math.floor(Number(n) || 1)); }

  async load(url: string) {
  // 新会话前重置时基与队列，避免继承旧会话时间轴
  this.videoDecodeQueue = [];
  this.audioQueue = [] as any[];
  this.audioBasePtsUs = undefined; this.audioBaseTime = undefined;
  this.pcrBasePtsUs = undefined; this.pcrBaseTime = undefined;
  this.videoBasePtsUs = undefined; this.videoBaseTime = undefined;
  this.mediaEpochUs = undefined;
  this.videoReadyForDeltas = false;
  // 新会话开始重置连续时间轴
  this.timelineOffsetUs = 0;
  // 重置音频调度地平线
  this.audioScheduledUntilS = 0;
  this._stopAllAudioSources();
  if (!this.worker) this._setupWorker();
  this.generationId++;
  const type = url.endsWith('.m3u8') ? 'openHLS' : (url.endsWith('.flv') ? 'openFLV' : 'open');
  this.lastSource = { kind: type === 'openHLS' ? 'hls' : (type === 'openFLV' ? 'flv' : 'mp4-url'), url };
  if (type === 'openHLS') {
    const startSeq = (typeof this.lastHlsSeq === 'number') ? Math.max(0, this.lastHlsSeq) : undefined;
    const startAtMs = (typeof this.startPositionMs === 'number') ? Math.max(0, this.startPositionMs) : undefined;
    this.worker?.postMessage({ type, url, startSeq, startAtMs, generationId: this.generationId });
  } else {
    this.worker?.postMessage({ type, url, generationId: this.generationId });
  }
  }

  async play(opts?: { video?: boolean; audio?: boolean }) {
    this.isPlaying = true;
  this.lastWasPlaying = true;
    this.emit('playing');
    if (this.audioCtx) {
      const st = String((this.audioCtx.state as any) || '');
      if (st === 'suspended' || st === 'interrupted') {
        await this.audioCtx.resume();
      }
    }
  this._ensureAudioUnlocked();
  // 兜底：在 autoplay 场景多做几次 resume，防止部分平台首次 resume 未生效
  try { this._resumeAudioContextWithRetries(); } catch {}
    // 启动渲染驱动：使用 requestAnimationFrame 节流决策（近似 vsync）
    if (!this.renderRafId) {
      const tick = () => {
        try { this.renderRafId = requestAnimationFrame(tick); } catch { this.renderRafId = window.setTimeout(() => { try { tick(); } catch {} }, 16) as any; }
        try { this._renderVideoFrame(); } catch {}
      };
      try { this.renderRafId = requestAnimationFrame(tick); } catch { this.renderRafId = window.setTimeout(() => { try { tick(); } catch {} }, 16) as any; }
    }
  }

  async pause() {
    this.isPlaying = false;
  this.lastWasPlaying = false;
  this.emit('paused');
  this.emit('buffering');
  if (this.audioCtx && String(this.audioCtx.state as any) === 'running') {
      await this.audioCtx.suspend();
    }
  if (this.renderRafId) { try { cancelAnimationFrame(this.renderRafId); } catch { try { window.clearTimeout(this.renderRafId as any); } catch {} } this.renderRafId = undefined; }
  }

  async stop() {
    this.isPlaying = false;
  this.lastWasPlaying = false;
    this.emit('ended');
  // 停止所有已调度的音频节点
  this._stopAllAudioSources();
  try { await (this.videoDecoder?.flush?.() || Promise.resolve()); } catch {}
  try { await (this.audioDecoder?.flush?.() || Promise.resolve()); } catch {}
  try { this.videoDecoder?.close?.(); } catch {}
  try { this.audioDecoder?.close?.(); } catch {}
  this.videoDecoder = undefined; this.audioDecoder = undefined; this.audioConfigured = false;
    if (this.audioCtx) {
      await this.audioCtx.close();
      this.audioCtx = undefined;
    }
  if (this.renderTimer) { window.clearInterval(this.renderTimer); this.renderTimer = undefined; }
  // 清空队列、重置状态
  this.videoDecodeQueue = [];
  this.audioQueue = [] as any[];
  this.audioBasePtsUs = undefined;
  this.audioBaseTime = undefined;
  this.audioConfigured = false;
  this.videoReadyForDeltas = false;
  this.pcrBasePtsUs = undefined; this.pcrBaseTime = undefined;
  this.mediaEpochUs = undefined;
  this.softwareVideoActive = false; this.softwareAudioActive = false;
  this.lastVideoPtsUs = undefined;
  this.timelineOffsetUs = 0;
  this.audioScheduledUntilS = 0;
  // 停止卡顿检测
  try { if (this.stallTimer) { window.clearInterval(this.stallTimer); this.stallTimer = undefined; } } catch {}
  // 停止时间事件定时器
  try { if (this.timeEventTimer) { window.clearInterval(this.timeEventTimer); this.timeEventTimer = undefined; } } catch {}
  }

  async seek(ms: number | bigint) {
    // 向 worker 发送 seek 消息
    if (this.worker) {
  // flush + 清空解码队列与时基，等待新的样本建立
  try { await (this.videoDecoder?.flush?.() || Promise.resolve()); } catch {}
  try { await (this.audioDecoder?.flush?.() || Promise.resolve()); } catch {}
  // 停止所有已调度的音频节点
  this._stopAllAudioSources();
  this.videoDecodeQueue = [];
  this.audioQueue = [] as any[];
  this.audioBasePtsUs = undefined; this.audioBaseTime = undefined;
  this.pcrBasePtsUs = undefined; this.pcrBaseTime = undefined;
  this.videoBasePtsUs = undefined; this.videoBaseTime = undefined;
  this.mediaEpochUs = undefined;
  this.videoReadyForDeltas = false;
  this.lastVideoPtsUs = undefined;
  this.audioScheduledUntilS = 0;
  const msNum = (typeof ms === 'bigint') ? Number(ms) : Number(ms);
  this.worker.postMessage({ type: 'seek', ms: msNum, generationId: this.generationId });
      this.emit('buffering');
    }
    // 可扩展：清空队列、等待新 sample
    // 连续时间轴：seek 到绝对时间
    if (this.continuousTimeline) {
  const msNum2 = (typeof ms === 'bigint') ? Number(ms) : Number(ms);
  this.timelineOffsetUs = Math.max(0, Math.floor(msNum2 || 0) * 1000);
    }
  }
  // 速率控制
  setPlaybackRate(rate: number) {
  this.targetPlaybackRate = Math.max(0.25, Math.min(4.0, Number(rate) || 1));
  this._ensurePlaybackRateTimer();
  // 立即应用到当前已调度的音频节点（随后定时器继续平滑靠近）
  this._applyPlaybackRateToSources();
    // 可扩展：视频帧时间戳缩放
  }

  setMuted(m: boolean) {
    this.muted = !!m; this._applyGain();
  }
  // 兼容：接受 0..3 或 0..1，>1 则按 0..3 刻度归一化
  setVolume(v: number) {
    let val = Number(v);
    if (!Number.isFinite(val)) val = 0;
    if (val > 1) val = val / 3;
    this.volume = Math.max(0, Math.min(1, val));
    this._applyGain();
  }
  // 兼容：对外返回 0..3 标尺
  getVolume() { return Math.round(this.volume * 3 * 1000) / 1000; }
  // 兼容：返回总时长（毫秒）
  getDuration() { return this.getDurationMs(); }
  // 兼容：外部 resize 透传到渲染器
  resize(w: number, h: number) {
    try { (this.renderer2D as any)?.resize?.(Math.floor(w)||0, Math.floor(h)||0); } catch {}
  }

  // 手动切换 HLS 码率：按索引（与 master 中顺序一致）
  setQuality(index: number) {
    try {
      if (!this.worker) this._setupWorker();
  const idx = Math.max(0, Math.floor(index));
  this.worker?.postMessage({ type: 'setHlsVariant', index: idx, generationId: this.generationId });
  // persist immediately with known master url (if any)
  try { const key = 'KIT_PLAYER_HLS_QUALITY_' + (this.lastHlsMasterUrl || ''); (typeof window!=='undefined'?window.localStorage:null)?.setItem(key, String(idx)); } catch {}
    } catch {}
  }
  // 手动切换 HLS 码率：按具体变体 URL
  setQualityUrl(url: string) {
    try {
      if (!this.worker) this._setupWorker();
  const u = String(url||'');
  this.worker?.postMessage({ type: 'setHlsVariant', url: u, generationId: this.generationId });
  // index persistence will happen on next hls-variant event
    } catch {}
  }

  // 偏好设置：WebCodecs 启用/禁用（分别控制视频/音频）；仅更新偏好并持久化
  setUseWebCodecs(prefs: { video?: boolean; audio?: boolean }) {
    try {
      const ls = (typeof window !== 'undefined' ? window.localStorage : null);
      if (typeof prefs.video === 'boolean') { this.prefUseWcVideo = !!prefs.video; ls?.setItem('KIT_PLAYER_USE_WEBCODECS_VIDEO', this.prefUseWcVideo ? '1' : '0'); }
      if (typeof prefs.audio === 'boolean') { this.prefUseWcAudio = !!prefs.audio; ls?.setItem('KIT_PLAYER_USE_WEBCODECS_AUDIO', this.prefUseWcAudio ? '1' : '0'); }
    } catch {}
  }
  // 偏好设置：硬解优先 vs 软解优先；仅更新偏好并持久化（下次重配生效）
  setHardwareAcceleration(mode: 'prefer-hardware'|'prefer-software') {
    try { this.prefHardwareAccel = (mode === 'prefer-software') ? 'prefer-software' : 'prefer-hardware'; (typeof window!=='undefined'?window.localStorage:null)?.setItem('KIT_PLAYER_HARDWARE_ACCEL', this.prefHardwareAccel); } catch {}
  }
  // 对齐 dist UI：audioMSE 开关（当前实现不生效，仅持久化供 UI 展示）
  setAudioMSEPreferred(on: boolean) {
    try { this.prefAudioMse = !!on; (typeof window!=='undefined'?window.localStorage:null)?.setItem('KIT_PLAYER_AUDIO_MSE', this.prefAudioMse ? '1' : '0'); } catch {}
  }
  private _ensureAudioGraph() {
    if (!this.audioCtx) this.audioCtx = new (window.AudioContext)();
    try {
  // 监听状态变化，出现 suspended/interrupted 时尝试恢复
      const ctx: any = this.audioCtx as any;
      if (!(ctx as any).__stateHooked) {
        this.audioCtx!.addEventListener('statechange', () => {
          try {
    if (!this.audioCtx) return;
  const st = String((this.audioCtx.state as any) || '');
  if (st === 'suspended' || st === 'interrupted') this._ensureAudioUnlocked();
          } catch {}
        });
        (ctx as any).__stateHooked = true;
      }
    } catch {}
    if (!this.gainNode && this.audioCtx) {
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.connect(this.audioCtx.destination);
    }
    this._applyGain();
  }

  // Initialize AudioWorklet time-stretch processor when supported.
  private _ensureTimeStretchWorklet(): Promise<void> {
    if (!this.timeStretchEnabled) return Promise.resolve();
    if (this._timeStretchInitPromise) return this._timeStretchInitPromise;
    this._timeStretchInitPromise = (async () => {
      try {
        if (!this.audioCtx) this.audioCtx = new (window.AudioContext)();
        if (!(this.audioCtx as any).audioWorklet) return;
        try {
          // addModule from blob
          const blob = new Blob([this.TIME_STRETCH_WORKLET_SOURCE], { type: 'application/javascript' });
          const url = URL.createObjectURL(blob);
          await (this.audioCtx as any).audioWorklet.addModule(url);
          URL.revokeObjectURL(url);
          this.audioWorkletNode = new (window as any).AudioWorkletNode(this.audioCtx, 'time-stretch-processor', { outputChannelCount: [2] });
          // connect to gain node / destination
          try { this._ensureAudioGraph(); this.audioWorkletNode.connect(this.gainNode || this.audioCtx.destination); } catch {}
        } catch (e) { /* not supported or failed */ }
      } catch (e) { /* ignore */ }
    })();
    return this._timeStretchInitPromise;
  }
  // 记录最近一次活动（用于卡顿检测）
  private _markActivity() { try { this.lastActivityTsMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()); } catch {} }

  // 周期性监测缓冲状态：依据已调度音频提前量与视频队列
  private _ensureStallMonitor() {
    try {
      if (this.stallTimer) return;
      this.stallTimer = window.setInterval(() => {
        try {
          // 仅在会话存在时评估
          const nowS = this.audioCtx ? this.audioCtx.currentTime : (performance.now() / 1000);
          const audioAheadS = this.audioCtx ? Math.max(0, this.audioScheduledUntilS - nowS) : 0;
          const vq = this.videoDecodeQueue.length;
          const hasAudio = !!this.audioDecoder && this.audioConfigured;
          let buffering = false;
          if (this.isPlaying) {
            if (hasAudio) {
              buffering = (audioAheadS < this.stallMinAudioAheadS) && (vq < 1);
            } else {
              const idleMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - (this.lastActivityTsMs || 0);
              buffering = (vq < 1) && (idleMs > this.stallNoAudioIdleMs);
            }
          }
          if (buffering !== this.lastBufferingState) {
            this.lastBufferingState = buffering;
            this.emit(buffering ? 'buffering' : 'playing');
          }
        } catch {}
      }, 250);
    } catch {}
  }
  private _applyGain() {
    if (!this.gainNode) return;
    const val = this.muted ? 0 : this.volume;
    try { this.gainNode.gain.value = val; } catch { /* ignore */ }
  }

  async openMP4(initBuffer: ArrayBuffer) {
  if (!this.worker) this._setupWorker();
  this.generationId++;
  // send init segment to worker for parsing
  this.lastSource = { kind: 'mp4-init', buffer: initBuffer };
  this.worker?.postMessage({ type: 'openMP4', buffer: initBuffer, generationId: this.generationId }, [initBuffer]);
  }

  // 读取运行时统计数据（浅拷贝，避免外部修改）
  getStats() {
    // 计算漂移分位（us）并转 ms
    const p50us = this._driftPercentile(50);
    const p95us = this._driftPercentile(95);
    const driftNowUs = this.getVideoDriftUs?.() as number | undefined;
    return {
      framesDrawn: this.stats.framesDrawn,
      framesDropped: this.stats.framesDropped,
      videoQueue: this.videoDecodeQueue.length,
      // KPI 摘要
      firstFrameTimeMs: this.kpi.firstFrameTimeMs,
      rebufferCount: this.kpi.rebufferCount || 0,
      rebufferDurationMs: this.kpi.rebufferDurationMs || 0,
      driftP50Ms: Math.round((p50us || 0) / 1000),
      driftP95Ms: Math.round((p95us || 0) / 1000),
      driftNowMs: typeof driftNowUs === 'number' ? Math.round(driftNowUs / 1000) : undefined,
    } as const;
  }

  // 可 seek 范围：VOD 返回 [0, duration]；LIVE 返回 [0, undefined]
  getSeekable() {
    const dur = this.getDurationMs();
    if (typeof dur === 'number' && dur > 0) return { startMs: 0, endMs: dur, isLive: false } as const;
    return { startMs: 0, endMs: undefined, isLive: true } as const;
  }

  // 当前播放时间（毫秒，基于音频或 PCR 时钟）
  getCurrentTimeMs(): number | undefined {
    const nowUs = this._getClockNowUs();
  if (nowUs === undefined || !Number.isFinite(nowUs) || Math.abs(nowUs) > 1e12) return undefined;
  const totalUs = this.continuousTimeline ? (this.timelineOffsetUs + nowUs) : nowUs;
  return totalUs / 1000;
  }

  getDurationMs(): number | undefined { return this.mediaDurationMs; }

  // —— 运行时调参 API ——
  // 预解码窗口（毫秒）
  setLookAheadMs(ms: number) { this.__lookAheadUs = this.MS_TO_US(Math.max(0, Number(ms) || 0)); }
  // 落后丢帧窗口（毫秒）
  setDropWindowMs(ms: number) { this.__dropWindowUs = this.MS_TO_US(Math.max(0, Number(ms) || 0)); }
  // 超前立即绘制阈值（毫秒）
  setLeadWindowMs(ms: number) { this.__leadWindowUs = this.MS_TO_US(Math.max(0, Number(ms) || 0)); }
  // 解码器 in-flight 上限
  setMaxVideoInFlight(n: number) { this.__maxVideoInFlight = Math.max(1, Math.floor(Number(n) || 1)); }
  // 待解码队列上限
  setMaxVideoQueue(n: number) { this.__maxVideoQueue = Math.max(30, Math.floor(Number(n) || 30)); }
  // 缓冲监控阈值：有音频时的最小“已排程前瞻时间”（秒）与无音频时的空闲阈值（毫秒）
  setStallThresholds(minAudioAheadS: number, noAudioIdleMs: number) {
    this.stallMinAudioAheadS = Math.max(0, Number(minAudioAheadS) || 0);
    this.stallNoAudioIdleMs = Math.max(0, Math.floor(Number(noAudioIdleMs) || 0));
  }
  // 设置引导喂入参数
  setBootstrapFeed(limitMs: number, maxFrames: number) {
    this.__bootstrapLimitUs = this.MS_TO_US(Math.max(0, Number(limitMs) || 0));
    this.__bootstrapMax = Math.max(0, Math.floor(Number(maxFrames) || 0));
  }
  // 开关：是否在音频未建立前使用 PCR 作为临时时钟
  setUsePcrBeforeAudio(on: boolean) { this.usePcrBeforeAudio = !!on; }
  // 设置 VOD 的 lead window（毫秒），但限制在 80~120ms 以避免唇同步退化
  setVodLeadWindowMs(ms: number) {
    try {
      const m = Math.max(80, Math.min(120, Math.floor(Number(ms) || 100)));
      this.__leadWindowDefaultVodUs = m * 1000;
    } catch {}
  }
  // 开关：是否启用连续时间轴（UI 连续）
  setContinuousTimeline(on: boolean) { this.continuousTimeline = !!on; }
  // 查询：当前缓冲/队列状态
  getBufferState() {
    const nowS = this.audioCtx ? this.audioCtx.currentTime : (performance.now() / 1000);
    const audioAheadS = this.audioCtx ? Math.max(0, this.audioScheduledUntilS - nowS) : 0;
    return {
      audioAheadS,
      videoQueued: this.videoDecodeQueue.length,
      maxVideoQueue: this.__maxVideoQueue,
      inFlightCap: this.__maxVideoInFlight
    };
  }
  // 查询：播放参数
  getPlaybackRate() { return this.playbackRate; }
  getMuted() { return this.muted; }
  // 旧版 getVolume 已改为返回 0..3 的兼容刻度
  getVideoQueueSize() { return this.videoDecodeQueue.length; }
  getAudioConfiguredInfo() { return { sampleRate: this.audioConfiguredSampleRate, channels: this.audioConfiguredChannels }; }
  // 查询：相对音频主钟的当前视频帧漂移估计（us），若无基准返回 undefined
  getVideoDriftUs(): number | undefined {
    try {
      if (!this.audioCtx || this.audioBasePtsUs === undefined || this.audioBaseTime === undefined || this.lastVideoPtsUs === undefined) return undefined;
      const nowS = this.audioCtx.currentTime;
      const nowMediaUs = this.audioBasePtsUs + Math.max(0, (nowS - this.audioBaseTime)) * 1e6 * Math.max(0.01, this.playbackRate);
      return this.lastVideoPtsUs - nowMediaUs;
    } catch { return undefined; }
  }
  // 查询：是否认为处于缓冲中（来自最近一次评估）
  isBuffering(): boolean { return !!this.lastBufferingState; }

  // 起播位置（毫秒），仅对 HLS VOD 生效：在 load(url) 前设置
  private startPositionMs?: number;
  setStartPositionMs(ms?: number) { this.startPositionMs = (typeof ms === 'number' && ms >= 0) ? Math.floor(ms) : undefined; }

  // 快速跳到直播尾（HLS live）
  goLive() { try { this.worker?.postMessage({ type: 'seek', ms: Number.MAX_SAFE_INTEGER, generationId: this.generationId }); this.emit('buffering'); } catch {} }

  // 重新附加画布（可选切换渲染器）
  attachCanvas(canvas: HTMLCanvasElement, renderer?: '2d'|'webgl') {
    try {
      // 解绑旧画布解锁事件
      const old = this.canvas as any;
      if (old && old.__unlockHooked && old.__unlockHandler) {
        try { old.removeEventListener('pointerdown', old.__unlockHandler); } catch {}
        try { old.removeEventListener('click', old.__unlockHandler); } catch {}
        old.__unlockHooked = false; old.__unlockHandler = undefined;
      }
    } catch {}
    this.canvas = canvas;
    if (renderer) this.setRenderer(renderer);
    // 新画布挂载解锁事件
    try {
      const el = this.canvas as any;
      if (el && !el.__unlockHooked) {
        const unlock = () => { try { this._ensureAudioUnlocked(); } catch {} };
        el.addEventListener('pointerdown', unlock, { passive: true });
        el.addEventListener('click', unlock, { passive: true });
        el.__unlockHooked = true; el.__unlockHandler = unlock;
      }
    } catch {}
  }

  // 切换渲染器实现
  setRenderer(kind: '2d'|'webgl') {
    try {
      if (kind === 'webgl') {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const ModGL = require('./renderer-webgl');
          this.renderer2D = new ModGL.RendererWebGL(this.canvas);
        } catch {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const Mod2D = require('./renderer-2d');
          this.renderer2D = new Mod2D.Renderer2D(this.canvas);
        }
      } else {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Mod2D = require('./renderer-2d');
        this.renderer2D = new Mod2D.Renderer2D(this.canvas);
      }
    } catch {}
  }

  // 彻底销毁，释放所有资源（包括 worker）
  async destroy() {
    try { await this.stop(); } catch {}
    try {
      if (this.worker) { try { this.worker.terminate(); } catch {} this.worker = undefined; }
    } catch {}
    // 解绑画布事件
    try {
      const el = this.canvas as any;
      if (el && el.__unlockHooked && el.__unlockHandler) {
        try { el.removeEventListener('pointerdown', el.__unlockHandler); } catch {}
        try { el.removeEventListener('click', el.__unlockHandler); } catch {}
        el.__unlockHooked = false; el.__unlockHandler = undefined;
      }
    } catch {}
    // 清理统计与监控定时器
  try { if (this.statsTimer) { window.clearInterval(this.statsTimer); this.statsTimer = undefined; } } catch {}
  try { if (this.timeEventTimer) { window.clearInterval(this.timeEventTimer); this.timeEventTimer = undefined; } } catch {}
    try { if (this.stallTimer) { window.clearInterval(this.stallTimer); this.stallTimer = undefined; } } catch {}
    // 页面可见性监听清理（全局一次性挂载，尽量也在销毁时清理）
    try {
      if ((window as any).__pc_vis_hooked && (window as any).__pc_vis_handler) {
        document.removeEventListener('visibilitychange', (window as any).__pc_vis_handler);
        (window as any).__pc_vis_hooked = false;
        (window as any).__pc_vis_handler = undefined;
      }
    } catch {}
  }

  private _setupWorker() {
    // 防缓存：为 worker.js 附加版本参数，避免浏览器用旧脚本
    try {
  // 每次创建都生成新的随机版本号，防止 HMR/ServiceWorker 复用旧 worker 缓存
  const bust = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      // 优先使用当前构建输出 dist/index.js；如不可用再回退根目录 worker.js
      const url1 = `dist/index.js?v=${bust}`;
      try {
        this.worker = new Worker(url1, { type: 'module' as any });
      } catch (e) {
        const url2 = `worker.js?v=${bust}`;
        this.worker = new Worker(url2);
      }
    } catch {
      // 兜底（极少数环境不允许上面代码时）
      this.worker = new Worker('worker.js');
    }
    this.worker.onmessage = (ev: MessageEvent) => this._onWorker(ev.data);
    this.worker.onerror = (ev: ErrorEvent) => {
      console.error('[PlayerCore] worker error', ev);
      this._restartWorker();
    };
  }

  // worker crash 自动重启，恢复当前 generationId
  private _restartWorker(): void {
    if (this.worker) {
      try { this.worker.terminate(); } catch(e) {}
      this.worker = undefined;
    }
    // 清空状态，避免旧帧/时基污染
    try { if (this.videoDecoder) { this.videoDecoder.close(); } } catch {}
    try { if (this.audioDecoder) { this.audioDecoder.close(); } } catch {}
    this.videoDecoder = undefined;
    this.audioDecoder = undefined;
  this.audioConfigured = false;
    this.videoDecodeQueue = [];
    this.audioQueue = [] as any[];
    this.audioBasePtsUs = undefined;
    this.audioBaseTime = undefined;
  this.videoReadyForDeltas = false;
  this.pcrBasePtsUs = undefined; this.pcrBaseTime = undefined;
  this.softwareVideoActive = false; this.softwareAudioActive = false;
  this.lastVideoPtsUs = undefined;
  this.audioScheduledUntilS = 0;
  this._stopAllAudioSources();
    if (this.renderTimer) { window.clearInterval(this.renderTimer); this.renderTimer = undefined; }

    this._setupWorker();
    // 自动恢复会话（仅针对 URL 源；mp4-init 为大缓冲，默认不复用以避免内存占用）
    if (this.lastSource) {
      this.generationId++;
      if (this.lastSource.kind === 'hls' && this.lastSource.url) {
        // 若为 LIVE，尽量从最后三片恢复以快速追尾
        let startSeq: number | undefined = undefined;
        if (typeof this.lastHlsSeq === 'number') {
          startSeq = Math.max(0, this.lastHlsSeq - 2);
        }
        this.worker?.postMessage({ type: 'openHLS', url: this.lastSource.url, startSeq, generationId: this.generationId });
      } else if (this.lastSource.kind === 'flv' && this.lastSource.url) {
        this.worker?.postMessage({ type: 'openFLV', url: this.lastSource.url, generationId: this.generationId });
      } else if (this.lastSource.kind === 'mp4-url' && this.lastSource.url) {
        this.worker?.postMessage({ type: 'open', url: this.lastSource.url, generationId: this.generationId });
      } else if (this.lastSource.kind === 'mp4-init' && this.lastSource.buffer) {
        // 出于内存考虑，默认不自动复用 init Buffer；如需可放开此分支
        // this.worker?.postMessage({ type: 'openMP4', buffer: this.lastSource.buffer, generationId: this.generationId }, [this.lastSource.buffer]);
      }
    }
    if (this.lastWasPlaying) {
      // 重新启动渲染循环，让解码/输出尽快恢复
      try { if (!this.renderTimer) this.renderTimer = window.setInterval(() => this._renderVideoFrame(), this.BACKUP_RENDER_INTERVAL_MS); } catch {}
    }
  }

  private _onWorker(msg: any): void {
    // generationId 校验，防止旧消息污染新会话
    if (!msg || typeof msg !== 'object') return;
    if ('generationId' in msg && msg.generationId !== this.generationId) {
      // 丢弃旧代际消息
      return;
    }
    // basic dispatch for stage1 & HLS
  switch (msg.type) {
      case 'buffering':
        // start a rebuffer period
        try { if (this.kpi.lastRebufferStartMs === undefined) this.kpi.lastRebufferStartMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()); } catch {}
        this.emit('buffering');
        break;
      case 'playing':
        // end rebuffer period
        try {
          if (typeof this.kpi.lastRebufferStartMs === 'number') {
            const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            this.kpi.rebufferCount = (this.kpi.rebufferCount || 0) + 1;
            this.kpi.rebufferDurationMs = (this.kpi.rebufferDurationMs || 0) + Math.max(0, now - (this.kpi.lastRebufferStartMs || now));
            this.kpi.lastRebufferStartMs = undefined;
          }
        } catch {}
        this.emit('playing');
        break;
      case 'ended':
      case 'eos':
        // 结束：停止渲染与音频节点
        try { if (this.renderTimer) { window.clearInterval(this.renderTimer); this.renderTimer = undefined; } } catch {}
        this._stopAllAudioSources();
        this.emit('ended');
        break;
      case 'ready-mp4':
        // 启动视频渲染定时器（以音频时钟驱动）
  if (!this.renderTimer) {
          // 启动渲染驱动（已由 play/open 路径触发）；同时在 ready 状态确定 VOD 并设置 leadWindow
          if (typeof this.mediaDurationMs === 'number' && this.mediaDurationMs > 0) {
            // VOD
            this.__leadWindowUs = this.__leadWindowDefaultVodUs;
          } else {
            this.__leadWindowUs = this.__leadWindowDefaultLiveUs;
          }
          this.renderRafId = requestAnimationFrame(() => this._renderVideoFrame());
        }
        break;
      case 'key-found':
        try {
          // 收到 worker 的 key-found 时，清理任何待定的 key-wait 定时器
          try { if (this.keyWaitTimer) { window.clearTimeout(this.keyWaitTimer); } } catch {} finally { this.keyWaitTimer = undefined; }
          if (typeof msg.ts === 'number') {
            const ms = Math.max(0, Math.floor(Number(msg.ts) / 1000));
            if ((window as any).__DEMO_DEBUG) console.warn('[worker] key-found seq=', msg.seq, 'tsUs=', msg.ts, ' -> ms=', ms);
            // 请求 worker 在该时间点 seek（适用于 HLS VOD 或基于 seq 的回退）
            try { this.worker?.postMessage({ type: 'seek', ms, generationId: this.generationId }); } catch {}
          }
        } catch {}
        break;
      case 'hls-variant':
        // ABR switch reported from worker
  try { this.kpi.abrSwitches = (this.kpi.abrSwitches || 0) + 1; } catch {}
  try {
    // track and persist selection per masterUrl
    if (msg && typeof msg.variantIndex === 'number') this.currentHlsVariantIndex = msg.variantIndex;
    if (msg && typeof msg.masterUrl === 'string') this.lastHlsMasterUrl = msg.masterUrl;
    // persist last selection
    try {
      const key = 'KIT_PLAYER_HLS_QUALITY_' + (this.lastHlsMasterUrl || '');
      if (this.currentHlsVariantIndex !== undefined) (typeof window!=='undefined'?window.localStorage:null)?.setItem(key, String(this.currentHlsVariantIndex));
    } catch {}
    this.emit('hls-variant', msg);
  } catch {}
  try { this.emit('stats', this.getStats()); } catch {}
        break;
      case 'hls-variants':
        try {
          // remember master and emit to UI
          if (msg && typeof msg.masterUrl === 'string') this.lastHlsMasterUrl = msg.masterUrl;
          this.emit('hls-variants', msg);
          // try auto-restore last chosen variant index from localStorage
          try {
            const ls = (typeof window !== 'undefined' ? window.localStorage : null);
            const key = 'KIT_PLAYER_HLS_QUALITY_' + (this.lastHlsMasterUrl || '');
            const saved = ls?.getItem(key);
            if (saved != null) {
              const idx = Math.max(0, Math.floor(Number(saved) || 0));
              if (Array.isArray(msg.list) && idx < msg.list.length) {
                this.currentHlsVariantIndex = idx;
                // command worker to switch
                this.worker?.postMessage({ type: 'setHlsVariant', index: idx, generationId: this.generationId });
              }
            }
          } catch {}
        } catch {}
        break;
      case 'key-not-found':
        try { if ((window as any).__DEMO_DEBUG) console.warn('[worker] key-not-found seq=', msg.seq); } catch {}
        break;
  try { if (msg.info && typeof msg.info.durationMs === 'number' && msg.info.durationMs > 0) this.mediaDurationMs = msg.info.durationMs; } catch {}
        // 音频解码器配置（仅当有 audio 信息且支持 WebCodecs）
  if (msg.info && msg.info.audio && typeof (window as any).AudioDecoder !== 'undefined') {
          try {
            this.audioCtx = this.audioCtx || new (window.AudioContext)();
            const desc = msg.info.audio.description || msg.info.audio.asc || null;
            // 如果参数变化则重新配置
            if (this.audioDecoder) {
              try { (this.audioDecoder as any).close(); } catch(e) {}
              this.audioDecoder = undefined;
            }
              this.audioDecoder = new (window as any).AudioDecoder({
                output: (frame: any) => {
                  try {
                    this.audioCtx = this.audioCtx || new (window.AudioContext)();
                    const numberOfChannels = (frame.numberOfChannels) || (frame.format && frame.format.channels) || 2;
                    const sampleRate = frame.sampleRate || 48000;
                    const frameCount = frame.numberOfFrames || frame.frameCount || 0;
                    // 如检测到真实采样率与当前配置不一致，则热重配
                    try {
                      if (this.audioConfigured && this.audioConfiguredSampleRate && sampleRate && Math.abs(sampleRate - this.audioConfiguredSampleRate) >= 1) {
                        this.audioSampleRateMismatchCount = (this.audioSampleRateMismatchCount || 0) + 1;
                        try { if ((window as any).__DEMO_DEBUG) console.warn('[audio] sampleRate mismatch detected', this.audioConfiguredSampleRate, '->', sampleRate); } catch {}
                        const old = this.audioDecoder; this.audioDecoder = undefined; this.audioConfigured = false;
                        try { old?.close?.(); } catch {}
                        const ad = new (window as any).AudioDecoder({
                          output: (f2: any) => {
                            try {
                              // 复用现有输出逻辑的简版（避免重复太多）
                              const nCh = (f2.numberOfChannels) || 2;
                              const sR = f2.sampleRate || sampleRate;
                              const fcnt = f2.numberOfFrames || 0;
                              let framePtsUs2: number | undefined = undefined;
                              if (typeof f2.timestamp === 'number') framePtsUs2 = this.normalizeTsToUs(f2.timestamp);
                              this._ensureAudioGraph();
                              const abuf = this.audioCtx!.createBuffer(nCh, fcnt, sR);
                              for (let ch = 0; ch < nCh; ch++) { const cd = new Float32Array(fcnt); try { f2.copyTo(cd, { planeIndex: ch }); } catch { f2.copyTo(cd); } abuf.copyToChannel(cd, ch, 0); }
                              const src2 = this.audioCtx!.createBufferSource(); src2.buffer = abuf; src2.connect(this.gainNode!);
                              this._registerAudioSource(src2);
                              try { (src2 as any).playbackRate.value = this.playbackRate; } catch {}
                              if (this.audioBasePtsUs !== undefined && framePtsUs2 !== undefined && this.audioBaseTime !== undefined) {
                                const offsetS = this.US_TO_S(framePtsUs2 - this.audioBasePtsUs);
                                const when = Math.max(this.audioCtx!.currentTime, this.audioBaseTime + offsetS);
                                const now = this.audioCtx!.currentTime; const durS = (fcnt / sR) / Math.max(0.01, this.playbackRate);
                                if (when <= now + 0.02) { src2.start(); this.audioScheduledUntilS = Math.max(this.audioScheduledUntilS, now + durS); } else { try { src2.start(when); } catch { src2.start(); } this.audioScheduledUntilS = Math.max(this.audioScheduledUntilS, when + durS); }
                                try { this._markActivity(); } catch {}
                              } else { src2.start(); }
                            } catch (e) {
                              console.warn('AudioDecoder output handling failed', e);
                            } finally {
                              try { f2.close(); } catch (e) {}
                            }
                          },
                          error: (e: any) => console.error('AudioDecoder error (reconfig)', e)
                        });
                        const nChCfg = this.audioConfiguredChannels || numberOfChannels;
                        const cfg2: any = { codec: this.audioLastCodec || 'mp4a.40.2', numberOfChannels: nChCfg, sampleRate: sampleRate };
                        if (this.audioLastDescription) cfg2.description = this.audioLastDescription;
                        try {
                          const ACtor: any = (window as any).AudioDecoder;
                          if (ACtor.isConfigSupported) { ACtor.isConfigSupported(cfg2).then((res: any) => { try { ad.configure(res?.config || cfg2); } catch { ad.configure(cfg2); } }).catch(() => { ad.configure(cfg2); }); }
                          else { ad.configure(cfg2); }
                        } catch { ad.configure(cfg2); }
                        this.audioDecoder = ad; this.audioConfigured = true; this.audioConfiguredSampleRate = sampleRate; this.audioConfiguredChannels = nChCfg;
                        try { if ((window as any).__DEMO_DEBUG) console.warn('[audio] hot reconfig to sampleRate=', sampleRate); } catch {}
                      }
                    } catch {}
                    // determine frame timestamp in microseconds
                    let framePtsUs: number | undefined = undefined;
                    if (typeof frame.timestamp === 'number') {
                      framePtsUs = this.normalizeTsToUs(frame.timestamp);
                    }

                    // init audio base mapping (zero baseline) if not set and we have a timestamp
                    if (framePtsUs !== undefined && this.audioBasePtsUs === undefined) {
                      this.audioBasePtsUs = 0;
                      this.audioBaseTime = this.audioCtx.currentTime + 0.20; // 更大安全偏移，减少调度抖动
                      // 一旦音频时基建立，清除 PCR/视频临时时钟，防止误用
                      this.pcrBasePtsUs = undefined; this.pcrBaseTime = undefined;
                      this.videoBasePtsUs = undefined; this.videoBaseTime = undefined;
                      try { if ((window as any).__DEMO_DEBUG) console.debug('[clock] audio base set (zero) at', this.audioBaseTime); } catch {}
                    }

                    // detect channel reconfiguration
                    if (this.audioConfigured && this.audioConfiguredChannels && numberOfChannels !== this.audioConfiguredChannels) {
                      this.audioChannelReconfigCount = (this.audioChannelReconfigCount || 0) + 1;
                      try { if ((window as any).__DEMO_DEBUG) console.warn('[audio] channel reconfig detected', this.audioConfiguredChannels, '->', numberOfChannels); } catch {}
                      this.audioConfiguredChannels = numberOfChannels;
                    }

                    const audioBuffer = this.audioCtx.createBuffer(numberOfChannels, frameCount, sampleRate);
                    const pcmArrays: ArrayBuffer[] = [];
                    for (let ch = 0; ch < numberOfChannels; ch++) {
                      try {
                        const channelData = new Float32Array(frameCount);
                        if (typeof frame.copyTo === 'function') {
                          try { frame.copyTo(channelData, { planeIndex: ch }); } catch (e) { frame.copyTo(channelData); }
                        }
                        audioBuffer.copyToChannel(channelData, ch, 0);
                        // store transferable copy for worklet
                        pcmArrays.push(channelData.buffer.slice(0));
                      } catch (e) { console.warn('audio channel copy failed', e); }
                    }

                    this._ensureAudioGraph();

                    // Attempt to use AudioWorklet time-stretch processor if initialized; post PCM to worklet async.
                    this._ensureTimeStretchWorklet().then(() => {
                      try {
                        if (this.audioWorkletNode && (this.audioWorkletNode as any).port) {
                          // configure
                          try { (this.audioWorkletNode as any).port.postMessage({ type: 'config', channels: numberOfChannels, sampleRate: sampleRate, rate: 1.0 }); } catch {}
                          // send PCM arrays as transferable
                          try { (this.audioWorkletNode as any).port.postMessage({ type: 'pcm', data: pcmArrays, channelCount: numberOfChannels }, pcmArrays); return; } catch(e) { /* fallback below */ }
                        }
                      } catch(e){}
                    }).catch(()=>{});

                    // fallback: create BufferSource if worklet not available or posting failed
                    const src = this.audioCtx.createBufferSource();
                    src.buffer = audioBuffer;
                    src.connect(this.gainNode!);
                    this._registerAudioSource(src);

                    // scheduling: compute desired start time based on pts mapping
                    if (framePtsUs !== undefined && (this.audioBaseTime !== undefined || (this.audioBaseTime === undefined && (this.audioBaseTime = this.audioCtx!.currentTime + 0.20)))) {
                      // 统一 0 轴：audioBasePtsUs 固定为 0
                      this.audioBasePtsUs = 0;
                      const offsetS = this.US_TO_S(framePtsUs - (this.audioBasePtsUs ?? 0)) / Math.max(0.01, this.playbackRate);
                      const when = Math.max(this.audioCtx!.currentTime, this.audioBaseTime + offsetS);
                      // if when is in the past, start immediately; else schedule
                      const now = this.audioCtx!.currentTime;
                      const durS = (frameCount / sampleRate) / Math.max(0.01, this.playbackRate);
                      if (when <= now + 0.02) {
                        src.start();
                        this.audioScheduledUntilS = Math.max(this.audioScheduledUntilS, now + durS);
                      } else {
                        try { src.start(when); } catch (e) { src.start(); }
                        this.audioScheduledUntilS = Math.max(this.audioScheduledUntilS, when + durS);
                      }
                      try { (src as any).playbackRate.value = this.playbackRate; } catch {}
                      try { this._markActivity(); } catch {}
                    } else {
                      // 没有可用的 pts 或其他原因，立即播放并推进已调度窗口
                      src.start();
                      try {
                        const now = this.audioCtx!.currentTime;
                        const durS = (frameCount / sampleRate) / Math.max(0.01, this.playbackRate);
                        this.audioScheduledUntilS = Math.max(this.audioScheduledUntilS, now + durS);
                        this._markActivity();
                      } catch {}
                    }
                  } catch (e) {
                    console.warn('AudioDecoder output handling failed', e);
                  } finally {
                    try { frame.close(); } catch (e) {}
                  }
                },
        error: (e: any) => console.error('AudioDecoder error', e)
              });
    const codec = msg.info.audio.codec || 'mp4a.40.2';
    const cfg: any = { codec };
    if (desc) cfg.description = desc;
    // 严格使用 worker 参数（若缺失再退默认）
    const numCh = (msg.info.audio && (msg.info.audio.numberOfChannels ?? (msg.info.audio as any).channels)) || 2;
    const sRate = (msg.info.audio && (msg.info.audio.sampleRate ?? (msg.info.audio as any).samplerate)) || 44100;
    cfg.numberOfChannels = numCh;
    cfg.sampleRate = sRate;
            (this.audioDecoder as any).configure(cfg);
      this.audioConfigured = true;
  this.audioConfiguredSampleRate = sRate; this.audioConfiguredChannels = numCh;
  this.audioLastCodec = codec; this.audioLastDescription = desc || null;
          } catch (e) { console.warn('AudioDecoder configure failed', e); }
        }
        // 视频解码器配置（如有 video 信息且支持 WebCodecs）
  if (msg.info && msg.info.video && typeof (window as any).VideoDecoder !== 'undefined') {
          try {
            const desc = msg.info.video.description || msg.info.video.avcC || null;
            // 从 avcC/description 缓存 SPS/PPS，便于关键帧注入
            if (desc) { try { this._cacheSpsPpsFromAvcC(desc); } catch {} }
            // 如果参数变化则重新配置
            if (this.videoDecoder) {
              try { (this.videoDecoder as any).close(); } catch(e) {}
              this.videoDecoder = undefined;
            }
            this.videoReadyForDeltas = false;
            this.videoDecoder = new (window as any).VideoDecoder({
              output: (frame: any) => {
          try { this.videoDecodeErrorStreak = 0; } catch {}
                try { this.videoDecodeErrorStreak = 0; } catch {}
                try { if ((window as any).__DEMO_DEBUG) console.debug('[vdec] output frame ts(us)=', typeof frame.timestamp==='number'? this.normalizeTsToUs(frame.timestamp): 'n/a'); } catch {}
                // 若尚无音频时钟与视频墙钟，使用首帧视频建立“墙钟回退”
                try {
                  if (this.audioBasePtsUs === undefined && (this.videoBasePtsUs === undefined || this.videoBaseTime === undefined)) {
                    if (typeof frame.timestamp === 'number') {
                      const ptsUs = Math.max(0, this.normalizeTsToUs(frame.timestamp));
                      this.videoBasePtsUs = ptsUs;
                      this.videoBaseTime = performance.now() / 1000;
            // 首帧输出发生，进入首屏引导期（2s），允许更宽松的 leadWindow 以避免黑屏
            try { this.bootstrapPhaseUntilPerfMs = performance.now() + 2000; } catch {}
                      try { if ((window as any).__DEMO_DEBUG) console.debug('[clock] video wall-clock base set us=', ptsUs, ' t0=', this.videoBaseTime); } catch {}
                    }
                  }
                } catch {}
                // 基于音频主钟的呈现调度
                const doDraw = () => {
                  try {
                    // firstPaint KPI
                    try {
                      if (this.kpi.firstFrameTimeMs === undefined) this.kpi.firstFrameTimeMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
                    } catch {}
                    // ensure canvas size matches frame
                    if (this.canvas && (this.canvas.width !== frame.codedWidth || this.canvas.height !== frame.codedHeight)) {
                      this.canvas.width = frame.codedWidth;
                      this.canvas.height = frame.codedHeight;
                    }
                    if (this.renderer2D && this.renderer2D.draw) {
                      try { this.renderer2D.draw(frame); } catch {}
                    } else {
                      const ctx = (this.canvas && this.canvas.getContext) ? this.canvas.getContext('2d') : null;
                      if (ctx) {
                        try { ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height); }
                        catch {
                          try {
                            createImageBitmap(frame).then((bmp) => {
                              try { ctx.drawImage(bmp, 0, 0, this.canvas.width, this.canvas.height); } catch {}
                              try { bmp.close(); } catch {}
                            }).catch(()=>{});
                          } catch {}
                        }
                      }
                    }
                  } catch (e) { /* ignore draw error */ }
                  finally { try { frame.close(); } catch {} this.stats.framesDrawn++; try { if ((window as any).__DEMO_DEBUG) console.debug('[draw] framesDrawn=', this.stats.framesDrawn); } catch {} try { this._markActivity(); } catch {} }
                };

                try {
                  const ptsUs = typeof frame.timestamp === 'number' ? this.normalizeTsToUs(frame.timestamp) : undefined;
                  if (ptsUs !== undefined && this.lastVideoPtsUs !== undefined && ptsUs < this.lastVideoPtsUs) {
                    try { frame.close(); } catch {}
                    this.videoReadyForDeltas = true;
                    return;
                  }
                  const drawWithUpdate = () => { doDraw(); if (ptsUs !== undefined) this.lastVideoPtsUs = ptsUs; };
                  if (ptsUs !== undefined && this.audioBasePtsUs !== undefined && this.audioBaseTime !== undefined && this.audioCtx) {
                    const nowS = this.audioCtx.currentTime;
                    const nowMediaUs = this.audioBasePtsUs + Math.max(0, (nowS - this.audioBaseTime)) * 1e6;
                    const driftUs = ptsUs - nowMediaUs;
                    try {
                      if (!Array.isArray(this.kpi.driftSamplesUs)) this.kpi.driftSamplesUs = [];
                      this.kpi.driftSamplesUs.push(Math.round(driftUs));
                      // cap sample history to last 2000 entries
                      if (this.kpi.driftSamplesUs.length > 2000) this.kpi.driftSamplesUs.splice(0, this.kpi.driftSamplesUs.length - 2000);
                    } catch {}
                    if (driftUs < -this.__dropWindowUs) {
                      // 严重落后，直接丢弃本帧
                      try { frame.close(); } catch {}
                      this.videoReadyForDeltas = true;
                      return;
                    }
                    // 动态 leadWindow：在首屏引导期放宽到 live 值，以避免首帧黑屏；稳态后使用默认值（VOD 更严格）
                    const nowPerf = (typeof performance !== 'undefined') ? performance.now() : Date.now();
                    const inBootstrap = (this.bootstrapPhaseUntilPerfMs !== undefined && nowPerf <= this.bootstrapPhaseUntilPerfMs);
                    const effectiveLeadUs = inBootstrap ? this.__leadWindowDefaultLiveUs : (typeof this.mediaDurationMs === 'number' && this.mediaDurationMs > 0 ? this.__leadWindowDefaultVodUs : this.__leadWindowDefaultLiveUs);
                    if (driftUs > effectiveLeadUs) {
                      // 严重超前，立即绘制一次，不再等待
                      drawWithUpdate();
                    } else {
                      const targetS = this.audioBaseTime + this.US_TO_S(ptsUs - this.audioBasePtsUs) / Math.max(0.01, this.playbackRate);
                      const delayMs = Math.max(0, (targetS - nowS) * 1000);
                      if (delayMs > 1) {
                        setTimeout(drawWithUpdate, Math.min(delayMs, 50));
                      } else {
                        drawWithUpdate();
                      }
                    }
                  } else {
                    drawWithUpdate();
                  }
                } catch { doDraw(); }
                this.videoReadyForDeltas = true;
              },
              error: (e: any) => {
                try {
                  this.videoDecodeErrorStreak = (this.videoDecodeErrorStreak || 0) + 1;
                  this.kpi.decodeErrors = (this.kpi.decodeErrors || 0) + 1;
                } catch {}
                console.error('VideoDecoder error', e, 'streak=', this.videoDecodeErrorStreak);
                try {
                  this.videoReadyForDeltas = false;
                  // 丢弃到下一个关键帧，避免错误状态持续
                  while (this.videoDecodeQueue.length && !this.videoDecodeQueue[0].key) { this.videoDecodeQueue.shift(); this.stats.framesDropped++; }
                } catch {}
                try {
                  if (this.videoDecodeErrorStreak >= this.decodeErrorThreshold) {
                    // 超过阈值 -> 请求 worker 定位下一个关键帧
                    this.videoDecodeErrorStreak = 0;
                    this._requestKeyFromWorker();
                    try { this.emit('stats', this.getStats()); } catch {}
                  }
                } catch {}
              }
            });
            const codec = msg.info.video.codec || 'avc1.42E01E';
            const cfg: any = { codec, optimizeForLatency: true };
            try { (cfg as any).hardwareAcceleration = this.prefHardwareAccel; } catch {}
            // 若 worker 指明 AnnexB，则不要设置 description（避免与 AnnexB 裸流冲突）
            const isAnnexB = !!(msg.info.video as any).annexb;
            if (!isAnnexB && desc) { cfg.description = desc; this.videoDescAttached = true; } else { this.videoDescAttached = false; }
            this.videoCodec = codec;
            // 缓存 avcC 中的 SPS/PPS，便于 AnnexB 关键帧注入
            try { if (desc) this._cacheSpsPpsFromAvcC(desc); } catch {}
            try {
              const Ctor: any = (window as any).VideoDecoder;
              if (Ctor.isConfigSupported) {
                Ctor.isConfigSupported(cfg).then((res: any) => {
                  try { this.videoDecoder.configure(res?.config || cfg); } catch(e) { this.videoDecoder.configure(cfg); }
                }).catch(() => { this.videoDecoder.configure(cfg); });
              } else {
                this.videoDecoder.configure(cfg);
              }
            } catch { this.videoDecoder.configure(cfg); }
          } catch (e) {
            console.warn('VideoDecoder configure failed', e);
            if (this.enableSoftwareFallback) {
              try {
                this.softwareVideoActive = true;
                // TODO: 在此处接入 ffmpeg.wasm 解码管线（占位）
                console.warn('[fallback] switching to software video decode (stub)');
              } catch (e2) { console.warn('software video fallback failed', e2); }
            }
          }
        }
        break;
      case 'hls-playlist':
        // 收到 m3u8 解析结果，调度分片拉取
        if (Array.isArray(msg.segments) && msg.segments.length > 0) {
          // 简单串行拉取所有分片（可扩展为按需/定时调度）
          for (const seg of msg.segments) {
            this.worker?.postMessage({ type: 'fetchSegment', uri: seg.uri });
          }
        }
        break;
      case 'hls-pos':
        if (typeof msg.seq === 'number') this.lastHlsSeq = msg.seq;
        // 可选：根据分片序号维持连续时间轴（需要 msg.segDurationMs）
        if (this.continuousTimeline && typeof msg.segStartMs === 'number') {
          this.timelineOffsetUs = Math.max(0, Math.floor(msg.segStartMs * 1000));
        }
        try { this.emit('hls-pos', msg); } catch {}
        break;
      case 'hls-download-stats':
        try { this.emit('hls-download-stats', msg); } catch {}
        break;
      case 'duration':
  if (typeof msg.ms === 'number' && msg.ms > 0) this.mediaDurationMs = msg.ms;
        break;
      case 'sample':
        // 统一时间单位与纪元：若本消息中任一时间字段看起来像 90kHz ticks（非常大），
        // 则把该消息的所有时间字段按 ticks->microseconds 统一转换，避免 ts/dts/pcr 单位混用。
        const detectTicks = (v: number | undefined) => (typeof v === 'number' && isFinite(v) && v > 3e9);
        const msgLooksLikeTicks = detectTicks(msg.ts) || detectTicks(msg.dts) || detectTicks((msg as any).pcr);
        const normalizeClock = (v: number | undefined) => {
          if (v === undefined || !isFinite(v)) return undefined;
          if (msgLooksLikeTicks) return Math.round(v * (1e6 / 90000));
          const isProbablyTicks = (v > 3e9);
          return isProbablyTicks ? Math.round(v * (1e6 / 90000)) : Math.round(v);
        };
        if (msg.kind === 'video' || msg.kind === 'audio') {
          const rawTs = normalizeClock(msg.ts)!;
          const rawDts = (typeof msg.dts === 'number') ? normalizeClock(msg.dts)! : undefined;
          const rawPcr = (typeof msg.pcr === 'number') ? normalizeClock(msg.pcr)! : undefined;
          // 首次见到任意样本，确定全局 epoch
          if (this.mediaEpochUs === undefined) this.mediaEpochUs = rawTs;
          // 所有时间戳减 epoch，落到同一 0 起点轴
          msg.ts = rawTs - this.mediaEpochUs;
          if (rawDts !== undefined) msg.dts = rawDts - this.mediaEpochUs;
          if (rawPcr !== undefined) msg.pcr = rawPcr - this.mediaEpochUs;
          // 在音频建立前，可选记录 PCR 基点的“墙钟映射”（不影响媒体轴）
          if (msg.kind === 'video' && this.usePcrBeforeAudio && this.audioBaseTime === undefined && typeof msg.pcr === 'number' && this.pcrBasePtsUs === undefined) {
            this.pcrBasePtsUs = msg.pcr; this.pcrBaseTime = performance.now() / 1000;
          }
        }
        // 视频 sample 入队（解码顺序队列：DTS 优先），等待音频主钟驱动送入解码器
        if (msg.kind === 'video') {
          // 懒配置：若未配置 VideoDecoder，先用稳妥参数配置一个（不带 description）
          if (!this.videoDecoder && typeof (window as any).VideoDecoder !== 'undefined') {
            try {
              const codec = (msg.codec as string) || this.videoCodec || 'avc1.42E01E';
              this.videoCodec = codec;
              const vout = (frame: any) => {
                try { this.videoDecodeErrorStreak = 0; } catch {}
                const doDraw = () => {
                  try {
                    if (this.canvas && (this.canvas.width !== frame.codedWidth || this.canvas.height !== frame.codedHeight)) {
                      this.canvas.width = frame.codedWidth; this.canvas.height = frame.codedHeight;
                    }
                    if (this.renderer2D && this.renderer2D.draw) { try { this.renderer2D.draw(frame); } catch {} }
                    else { const ctx = this.canvas.getContext('2d'); if (ctx) { try { ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height); } catch {} } }
                  } catch {}
                  finally { try { frame.close(); } catch {} this.stats.framesDrawn++; try { this._markActivity(); } catch {} }
                };
                try {
                  const ptsUs = typeof frame.timestamp === 'number' ? this.normalizeTsToUs(frame.timestamp) : undefined;
                  // 若尚无音频/PCR 时钟，且未建立视频墙钟基准，则用首个输出帧建立基准
                  if (ptsUs !== undefined && this.audioBasePtsUs === undefined && this.pcrBasePtsUs === undefined && (this.videoBasePtsUs === undefined || this.videoBaseTime === undefined)) {
                    this.videoBasePtsUs = ptsUs;
                    this.videoBaseTime = performance.now() / 1000;
                    try { if ((window as any).__DEMO_DEBUG) console.warn('[clock] video wall-clock base set from output ts(us)=', ptsUs); } catch {}
                  }
                  if (ptsUs !== undefined && this.lastVideoPtsUs !== undefined && ptsUs < this.lastVideoPtsUs) {
                      try { frame.close(); } catch {}
                    this.videoReadyForDeltas = true;
                    return;
                  }
                  const drawWithUpdate = () => { doDraw(); if (ptsUs !== undefined) this.lastVideoPtsUs = ptsUs; };
                  if (ptsUs !== undefined && this.audioBasePtsUs !== undefined && this.audioBaseTime !== undefined && this.audioCtx) {
                    const targetS = this.audioBaseTime + this.US_TO_S(ptsUs - this.audioBasePtsUs) / Math.max(0.01, this.playbackRate);
                    const nowS = this.audioCtx.currentTime;
            const delayMs = Math.max(0, (targetS - nowS) * 1000);
                    if (delayMs > 1) setTimeout(drawWithUpdate, Math.min(delayMs, 50)); else drawWithUpdate();
                  } else { drawWithUpdate(); }
                } catch { doDraw(); }
                this.videoReadyForDeltas = true;
              };
              const verr = (e: any) => {
                try { this.videoDecodeErrorStreak = (this.videoDecodeErrorStreak || 0) + 1; } catch {}
                console.error('VideoDecoder error (lazy)', e, 'streak=', this.videoDecodeErrorStreak);
                try { if (this.videoDecodeErrorStreak >= this.decodeErrorThreshold) { this.videoDecodeErrorStreak = 0; this._requestKeyFromWorker(); } } catch {}
              };
              const dec = new (window as any).VideoDecoder({ output: vout, error: verr });
              const cfg: any = { codec, optimizeForLatency: true };
              try { (cfg as any).hardwareAcceleration = 'prefer-hardware'; } catch {}
              const VCtor: any = (window as any).VideoDecoder;
              if (VCtor.isConfigSupported) {
                VCtor.isConfigSupported(cfg)
                  .then((r: any) => { try { dec.configure(r?.config || cfg); } catch { dec.configure(cfg); } })
                  .catch(() => { try { dec.configure(cfg); } catch {} });
              } else { try { dec.configure(cfg); } catch {} }
              this.videoDecoder = dec;
              this.videoDescAttached = false; this.videoReadyForDeltas = false;
              try { if ((window as any).__DEMO_DEBUG) console.warn('[video] lazy configured:', codec); } catch {}
            } catch (e) { console.warn('video lazy-config failed', e); }
          }
          try { if ((window as any).__DEMO_DEBUG) console.debug('[queue] video sample enq, ts(us)=', this.normalizeTsToUs(msg.ts)); } catch {}
          // ts/dts 已经按 epoch 对齐为微秒；无需再次转换
          // 第一次看到视频样本时检测实际格式；如是 AnnexB 且当前配置附带 description，则去掉 description 热重配
          if (!this.firstVideoSeen) {
            this.firstVideoSeen = true;
            try {
              this.annexbDetected = this._isAnnexB(msg.data);
              if (this.annexbDetected && this.videoDescAttached && typeof (window as any).VideoDecoder !== 'undefined') {
                try {
                  const old = this.videoDecoder; this.videoDecoder = undefined; try { old?.close?.(); } catch {}
                  const vdec = new (window as any).VideoDecoder({
                    output: (frame: any) => {
                      try { if ((window as any).__DEMO_DEBUG) console.debug('[vdec] output frame ts(us)=', typeof frame.timestamp==='number'? this.normalizeTsToUs(frame.timestamp): 'n/a'); } catch {}
                      // 与 ready-mp4 路径一致的绘制逻辑
                      const doDraw = () => {
                        try {
                          if (this.canvas && (this.canvas.width !== frame.codedWidth || this.canvas.height !== frame.codedHeight)) { this.canvas.width = frame.codedWidth; this.canvas.height = frame.codedHeight; }
                          if (this.renderer2D && this.renderer2D.draw) { try { this.renderer2D.draw(frame); } catch {} }
                          else { const ctx = (this.canvas && this.canvas.getContext) ? this.canvas.getContext('2d') : null; if (ctx) { try { ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height); } catch {} } }
                        } catch {}
                        finally { try { frame.close(); } catch {} this.stats.framesDrawn++; try { this._markActivity(); } catch {} }
                      };
                      try {
                        const ptsUs = typeof frame.timestamp === 'number' ? this.normalizeTsToUs(frame.timestamp) : undefined;
                        // 若尚无音频/PCR 时钟，且未建立视频墙钟基准，则用首个输出帧建立基准
                        if (ptsUs !== undefined && this.audioBasePtsUs === undefined && this.pcrBasePtsUs === undefined && (this.videoBasePtsUs === undefined || this.videoBaseTime === undefined)) {
                          this.videoBasePtsUs = ptsUs;
                          this.videoBaseTime = performance.now() / 1000;
                          try { if ((window as any).__DEMO_DEBUG) console.warn('[clock] video wall-clock base set from output ts(us)=', ptsUs); } catch {}
                        }
                        if (ptsUs !== undefined && this.lastVideoPtsUs !== undefined && ptsUs < this.lastVideoPtsUs) {
                          try { frame.close(); } catch {}
                          this.videoReadyForDeltas = true;
                          return;
                        }
                        const drawWithUpdate = () => { doDraw(); if (ptsUs !== undefined) this.lastVideoPtsUs = ptsUs; };
                        if (ptsUs !== undefined && this.audioBasePtsUs !== undefined && this.audioBaseTime !== undefined && this.audioCtx) {
                          const targetS = this.audioBaseTime + this.US_TO_S(ptsUs - this.audioBasePtsUs) / Math.max(0.01, this.playbackRate);
                          const nowS = this.audioCtx.currentTime;
                          const delayMs = Math.max(0, (targetS - nowS) * 1000);
                          if (delayMs > 1) setTimeout(drawWithUpdate, Math.min(delayMs, 50)); else drawWithUpdate();
                        } else { drawWithUpdate(); }
                      } catch { doDraw(); }
                      this.videoReadyForDeltas = true;
                    },
                    error: (e: any) => {
                      try { this.videoDecodeErrorStreak = (this.videoDecodeErrorStreak || 0) + 1; } catch {}
                      console.error('VideoDecoder error (reconfig)', e, 'streak=', this.videoDecodeErrorStreak);
                      try { if (this.videoDecodeErrorStreak >= this.decodeErrorThreshold) { this.videoDecodeErrorStreak = 0; this._requestKeyFromWorker(); } } catch {}
                    }
                  });
                  const cfg2: any = { codec: this.videoCodec || 'avc1.42E01E', optimizeForLatency: true };
                  try { (cfg2 as any).hardwareAcceleration = 'prefer-hardware'; } catch {}
                  const VCtor: any = (window as any).VideoDecoder;
                  if (VCtor && VCtor.isConfigSupported) {
                    VCtor.isConfigSupported(cfg2)
                      .then((res: any) => { try { vdec.configure(res?.config || cfg2); } catch { vdec.configure(cfg2); } })
                      .catch(() => { vdec.configure(cfg2); });
                  } else { vdec.configure(cfg2); }
                  this.videoDecoder = vdec; this.videoDescAttached = false; this.videoReadyForDeltas = false;
                  if ((window as any).__DEMO_DEBUG) { try { console.warn('[video] hot reconfig: remove description for AnnexB'); } catch {} }
                } catch(e) { console.warn('video hot-reconfig failed', e); }
              }
            } catch {}
          }
          // 若既无音频也无 PCR，也还没视频墙钟，用首个视频样本先建立 provisional 墙钟
          if (this.audioBaseTime === undefined && this.pcrBaseTime === undefined && (this.videoBaseTime === undefined || this.videoBasePtsUs === undefined) && typeof msg.ts === 'number' && isFinite(msg.ts)) {
            this.videoBasePtsUs = msg.ts;
            this.videoBaseTime = performance.now() / 1000;
            try { if ((window as any).__DEMO_DEBUG) console.warn('[clock] provisional video wall-clock set from first sample ts(us)=', this.videoBasePtsUs, ' t0=', this.videoBaseTime); } catch {}
          }

          // 若尚未见到首个 audio 且 PCR 可用，则把 audioBaseTime 临时映射到 PCR 墙钟（audioBasePtsUs 仍为 0）
          if (this.audioBasePtsUs === undefined && this.pcrBasePtsUs !== undefined && this.pcrBaseTime !== undefined) {
            // 设定一个虚拟 audioBaseTime，使得后续 getClockNowUs 可优先返回基于 PCR 的时间
            if (this.audioBaseTime === undefined) {
              // audioBasePtsUs 保持 0（统一零基线），audioBaseTime 映射到 pcrBaseTime - offset
              this.audioBasePtsUs = 0;
              // 将 audioBaseTime 对齐到当前 PCR 墙钟映射
              // 令 audioBaseTime 对应的 media pts 为 0，当 PCR 对应的 pts 为 pcrBasePtsUs 时：
              // audioBaseTime = pcrBaseTime - pcrBasePtsUs/1e6
              this.audioBaseTime = this.pcrBaseTime - ((this.pcrBasePtsUs - (this.audioBasePtsUs ?? 0)) / 1e6);
              try { if ((window as any).__DEMO_DEBUG) console.debug('[clock] audio base provisional mapped to PCR at', this.audioBaseTime); } catch {}
            }
          }

          // 进一步防御：夹紧异常 dts 到 pts 附近
          let safeDts: number | undefined = undefined;
          try {
            if (typeof msg.dts === 'number') {
              const d = Number(msg.dts) || 0;
              const p = Number(msg.ts) || 0;
              if (isFinite(d)) {
                const diff = d - p;
                safeDts = (Math.abs(diff) > 5_000_000 || d < 0) ? p : d;
              }
            }
          } catch {}
          try {
            if ((window as any).__DEMO_DEBUG) {
              console.debug('[enq]', { kind: 'video', ts: msg.ts, dts: safeDts ?? msg.dts, pcr: msg.pcr, baseV: this.videoBasePtsUs, baseA: this.audioBasePtsUs });
            }
          } catch {}
          this.videoDecodeQueue.push({ ts: msg.ts, dts: safeDts, key: !!msg.key, data: msg.data, dur: typeof msg.dur === 'number' ? this.normalizeTsToUs(msg.dur) : undefined });
          if (this.videoDecodeQueue.length > 1) {
            const pick = (s: { ts: number; dts?: number }) => (s.dts ?? s.ts);
            this.videoDecodeQueue.sort((a, b) => pick(a) - pick(b));
          }
          // key-wait: 若队列中暂无关键帧，则启动一次短定时器（keyWaitMs），超时后请求 worker 帮助定位下一个关键帧
          try {
            const hasKey = this.videoDecodeQueue.some(x => !!x.key);
            if (!hasKey) {
              if (!this.keyWaitTimer) {
                this.keyWaitTimer = window.setTimeout(() => {
                  try {
                    this.keyWaitTimer = undefined;
                    // 再次确认队列内仍无关键帧
                    const stillNoKey = !this.videoDecodeQueue.some(x => !!x.key);
                    if (stillNoKey) this._requestKeyFromWorker();
                  } catch {}
                }, Math.max(20, Math.floor(Number(this.keyWaitMs) || 80)));
              }
            } else {
              if (this.keyWaitTimer) { try { window.clearTimeout(this.keyWaitTimer); } catch {} this.keyWaitTimer = undefined; }
            }
          } catch {}
          // 高水位背压：超过上限时丢弃最旧的若干帧（按 DTS 排序的队头）
          if (this.videoDecodeQueue.length > this.__maxVideoQueue) {
            const overflow = this.videoDecodeQueue.length - this.__maxVideoQueue;
            this.videoDecodeQueue.splice(0, overflow);
          }
          // 立刻尝试推进一次渲染，并确保渲染循环已启动
          try { this._renderVideoFrame(); } catch {}
          try { if (!this.renderTimer) this.renderTimer = window.setInterval(() => this._renderVideoFrame(), this.BACKUP_RENDER_INTERVAL_MS); } catch {}
        }
        // 音频 sample 直接解码
  // 懒配置：若未配置 AudioDecoder 且允许使用 WebCodecs 音频，先按稳妥参数配置
  if (msg.kind === 'audio' && this.prefUseWcAudio && !this.audioDecoder && typeof (window as any).AudioDecoder !== 'undefined') {
          try {
            const codec = (msg.codec as string) || this.audioLastCodec || 'mp4a.40.2';
            const numCh = (msg.channels as number) || 2;
            const sRate = (msg.sampleRate as number) || 44100;
            this.audioCtx = this.audioCtx || new (window.AudioContext)();
            const ad = new (window as any).AudioDecoder({
              output: (frame: any) => {
                try {
                  try { if (this.audioCtx && String(this.audioCtx.state as any) === 'suspended') this.audioCtx.resume(); } catch {}
                  const numberOfChannels = frame.numberOfChannels || numCh;
                  const sampleRate = frame.sampleRate || sRate;
                  const frameCount = frame.numberOfFrames || frame.frameCount || 0;
                  let framePtsUs: number | undefined = undefined;
                  if (typeof frame.timestamp === 'number') framePtsUs = this.normalizeTsToUs(frame.timestamp);
                  if (framePtsUs !== undefined && this.audioBasePtsUs === undefined) {
                    this.audioBasePtsUs = 0; this.audioBaseTime = this.audioCtx.currentTime + 0.20;
                    this.pcrBasePtsUs = undefined; this.pcrBaseTime = undefined;
                    this.videoBasePtsUs = undefined; this.videoBaseTime = undefined;
                  }
                  this._ensureAudioGraph();
                  const audioBuffer = this.audioCtx!.createBuffer(numberOfChannels, frameCount, sampleRate);
                  for (let ch = 0; ch < numberOfChannels; ch++) { const channelData = new Float32Array(frameCount); try { frame.copyTo(channelData, { planeIndex: ch }); } catch { frame.copyTo(channelData); } audioBuffer.copyToChannel(channelData, ch, 0); }
                  const src = this.audioCtx!.createBufferSource(); src.buffer = audioBuffer; src.connect(this.gainNode!);
                  this._registerAudioSource(src);
                  if (this.audioBasePtsUs !== undefined && framePtsUs !== undefined && this.audioBaseTime !== undefined) {
                    const offsetS = this.US_TO_S(framePtsUs - (this.audioBasePtsUs ?? 0)) / Math.max(0.01, this.playbackRate);
                    const when = Math.max(this.audioCtx!.currentTime, this.audioBaseTime + offsetS);
                    const now = this.audioCtx!.currentTime; const durS = (frameCount / sampleRate) / Math.max(0.01, this.playbackRate);
                    if (when <= now + 0.02) { src.start(); this.audioScheduledUntilS = Math.max(this.audioScheduledUntilS, now + durS); } else { try { src.start(when); } catch { src.start(); } this.audioScheduledUntilS = Math.max(this.audioScheduledUntilS, when + durS); }
                    try { (src as any).playbackRate.value = this.playbackRate; } catch {}
                    try { this._markActivity(); } catch {}
                  } else { src.start(); }
                } catch (e) { console.warn('AudioDecoder output handling failed (lazy)', e); }
                finally { try { frame.close(); } catch {} }
              },
              error: (e: any) => console.error('AudioDecoder error (lazy)', e)
            });
            const cfg: any = { codec, numberOfChannels: numCh, sampleRate: sRate };
            const ACtor: any = (window as any).AudioDecoder;
            if (ACtor.isConfigSupported) {
              ACtor.isConfigSupported(cfg)
                .then((r: any) => { try { ad.configure(r?.config || cfg); } catch { ad.configure(cfg); } })
                .catch(() => { ad.configure(cfg); });
            } else { try { ad.configure(cfg); } catch {} }
            this.audioDecoder = ad; this.audioConfigured = true;
            this.audioConfiguredChannels = numCh; this.audioConfiguredSampleRate = sRate;
            this.audioLastCodec = codec; this.audioLastDescription = null;
            try { if ((window as any).__DEMO_DEBUG) console.warn('[audio] lazy configured:', codec, numCh, sRate); } catch {}
          } catch(e) { console.warn('audio lazy-config failed', e); }
        }
  if (msg.kind === 'audio') {
          try {
            // 如果尚未建立 audioBase，但已知 PCR 基点，则用 PCR 填充 audioBase（使进度先走起来）
            try {
              if (this.audioBasePtsUs === undefined && this.pcrBasePtsUs !== undefined && this.pcrBaseTime !== undefined) {
                this.audioBasePtsUs = 0;
                // audioBaseTime 对应的 media pts 为 0，当 PCR 对应的 pts 为 pcrBasePtsUs 时：
                // audioBaseTime = pcrBaseTime - pcrBasePtsUs/1e6
                this.audioBaseTime = this.pcrBaseTime - ((this.pcrBasePtsUs - (this.audioBasePtsUs ?? 0)) / 1e6);
                try { if ((window as any).__DEMO_DEBUG) console.debug('[clock] audio base provisional mapped to PCR at (audio sample)', this.audioBaseTime); } catch {}
              }
            } catch {}
            // 跳过空音频帧，避免解码错误并阻塞音频时钟建立
            const dataLen = (msg.data && (msg.data as ArrayBuffer).byteLength) ? (msg.data as ArrayBuffer).byteLength : 0;
            // 空音频帧也可用于建立音频时基（只建立时钟，不解码音频数据）
            if (dataLen <= 0) {
              try {
                if (typeof msg.ts === 'number') {
                  this.audioCtx = this.audioCtx || new (window.AudioContext)();
                  if (this.audioBasePtsUs === undefined) {
                    this.audioBasePtsUs = 0;
                    this.audioBaseTime = this.audioCtx.currentTime + 0.20;
                    this.pcrBasePtsUs = undefined; this.pcrBaseTime = undefined;
                    this.videoBasePtsUs = undefined; this.videoBaseTime = undefined;
                  }
                  // 若消息包含 duration，可合成一段静音并按 timestamp/duration 排程，改善听感
                  if (typeof msg.dur === 'number' && msg.dur > 0 && this.audioCtx) {
                    try {
                      const durUs = this.normalizeTsToUs(msg.dur);
                      const durS = Math.max(0.001, durUs / 1e6);
                      const ch = this.audioConfiguredChannels || 2;
                      const sR = this.audioConfiguredSampleRate || 48000;
                      const frameCount = Math.max(1, Math.floor(durS * sR));
                      const buf = this.audioCtx.createBuffer(ch, frameCount, sR);
                      // buffer already zeros => silent
                      const src = this.audioCtx.createBufferSource(); src.buffer = buf; src.connect(this.gainNode || this.audioCtx.destination);
                      this._registerAudioSource(src);
                      try { (src as any).playbackRate.value = this.playbackRate; } catch {}
                      const scheduleWhen = Math.max(this.audioCtx.currentTime, this.audioBaseTime + this.US_TO_S(this.normalizeTsToUs(msg.ts) - (this.audioBasePtsUs ?? 0)));
                      try { src.start(scheduleWhen); } catch { src.start(); }
                      this.audioScheduledUntilS = Math.max(this.audioScheduledUntilS, scheduleWhen + durS);
                    } catch (e) { /* ignore silent synthesis errors */ }
                  }
                }
              } catch {}
              break;
            }

            // normalize & clamp ts
            msg.ts = this.normalizeTsToUs(msg.ts);
            const tsSafe = Math.max(0, Number(msg.ts) || 0);

    const tryDecodeWithAudioDecoder = () => {
              return new Promise<boolean>(resolve => {
                try {
      if (this.prefUseWcAudio && this.audioDecoder && this.audioConfigured) {
                    const ainit: any = { type: 'key', timestamp: tsSafe, data: msg.data };
                    if (typeof msg.dur === 'number' && msg.dur > 0) ainit.duration = this.normalizeTsToUs(msg.dur);
                    const chunk = new (window as any).EncodedAudioChunk(ainit);
                    try { (this.audioDecoder as any).decode(chunk); resolve(true); } catch (e) { console.warn('audioDecoder.decode threw, will fallback', e); resolve(false); }
                    return;
                  }
                } catch (e) { console.warn('audio decode attempt failed', e); }
                resolve(false);
              });
            };

    // 若未允许 WebCodecs 音频，直接走软解；否则优先尝试硬解
    (this.prefUseWcAudio ? tryDecodeWithAudioDecoder() : Promise.resolve(false)).then((decoded) => {
              if (!decoded) {
                // AudioDecoder not available or failed: attempt soft fallback using decodeAudioData
                try {
                  this.kpi.softAudioFallbacks = (this.kpi.softAudioFallbacks || 0) + 1;
                  this.audioCtx = this.audioCtx || new (window.AudioContext)();
                  // decodeAudioData expects an ArrayBuffer; use a copy to be safe
                  const ab = msg.data as ArrayBuffer;
                  const decodePromise = new Promise<AudioBuffer>((resolve, reject) => {
                    try {
                      const cb = (buf: AudioBuffer) => resolve(buf);
                      const eb = (err: any) => reject(err || new Error('decodeAudioData failed'));
                      const decP = (this.audioCtx as any).decodeAudioData(ab.slice ? ab.slice(0) : ab, cb, eb);
                      if (decP && decP.then) decP.then(resolve).catch(reject);
                    } catch (e) { reject(e); }
                  });
                  decodePromise.then((audioBuffer) => {
                    try {
                      const src = this.audioCtx!.createBufferSource(); src.buffer = audioBuffer; src.connect(this.gainNode || this.audioCtx!.destination);
                      this._registerAudioSource(src);
                      try { (src as any).playbackRate.value = this.playbackRate; } catch {}
                      if (this.audioBasePtsUs !== undefined && tsSafe !== undefined && this.audioBaseTime !== undefined) {
                        const offsetS = this.US_TO_S(tsSafe - (this.audioBasePtsUs ?? 0)) / Math.max(0.01, this.playbackRate);
                        const when = Math.max(this.audioCtx!.currentTime, this.audioBaseTime + offsetS);
                        const now = this.audioCtx!.currentTime; const durS = audioBuffer.duration / Math.max(0.01, this.playbackRate);
                        if (when <= now + 0.02) { src.start(); this.audioScheduledUntilS = Math.max(this.audioScheduledUntilS, now + durS); } else { try { src.start(when); } catch { src.start(); } this.audioScheduledUntilS = Math.max(this.audioScheduledUntilS, when + durS); }
                        try { this._markActivity(); } catch {}
                      } else { src.start(); }
                    } catch (e) { console.warn('soft decode schedule failed', e); }
                  }).catch((e) => { try { this.emit('audio-missing', e); } catch {} });
                } catch (e) { try { this.emit('audio-missing', e); } catch {} }
              }
            }).catch((e) => { console.warn('audio decode flow failed', e); });
          } catch (e) { console.warn('audio handling failed', e); }
        }
        break;
      case 'stream-info':
        // worker 显式声明流属性（例如无音频），则关闭音频时钟，启用视频/PCR 回退
        try {
          if (msg.hasAudio === false) {
            try { if (this.audioDecoder) { this.audioDecoder.close(); } } catch {}
            this.audioDecoder = undefined; this.audioConfigured = false;
            this.audioBasePtsUs = undefined; this.audioBaseTime = undefined;
          }
        } catch {}
        break;
      case 'discontinuity':
        // 分片/轨道发生 DISCONTINUITY：重置时基与队列，按新段首帧重建零点
        try {
          try { (this.videoDecoder?.flush?.() || Promise.resolve()).catch(()=>{}); } catch {}
          try { (this.audioDecoder?.flush?.() || Promise.resolve()).catch(()=>{}); } catch {}
          this.videoDecodeQueue = [];
          this.audioQueue = [] as any[];
          this.videoReadyForDeltas = false;
          this.audioBasePtsUs = undefined; this.audioBaseTime = undefined;
          this.videoBasePtsUs = undefined; this.videoBaseTime = undefined;
          this.pcrBasePtsUs = undefined; this.pcrBaseTime = undefined;
          this.mediaEpochUs = undefined;
          this.firstVideoSeen = false; this.annexbDetected = false;
          this.lastVideoPtsUs = undefined;
          // 保持 UI 连续：累加时间轴偏移
          if (this.continuousTimeline && typeof msg.nextStartUs === 'number') {
            this.timelineOffsetUs = Math.max(this.timelineOffsetUs, Math.floor(msg.nextStartUs));
          }
          this._stopAllAudioSources();
          if ((window as any).__DEMO_DEBUG) { try { console.warn('[clock] discontinuity: reset bases and queues'); } catch {} }
        } catch {}
        break;
      case 'config-update':
        // 运行时 extradata 变化（SPS/PPS/ASC），执行解码器重配置
  if (msg.video && typeof (window as any).VideoDecoder !== 'undefined') {
          try {
            if (this.videoDecoder) { try { this.videoDecoder.close(); } catch(e) {} }
            this.videoReadyForDeltas = false;
            this.videoDecoder = new (window as any).VideoDecoder({
              output: (frame: any) => {
                const doDraw = () => {
                  try {
                    if (this.canvas && (this.canvas.width !== frame.codedWidth || this.canvas.height !== frame.codedHeight)) {
                      this.canvas.width = frame.codedWidth; this.canvas.height = frame.codedHeight;
                    }
                    if (this.renderer2D && this.renderer2D.draw) { try { this.renderer2D.draw(frame); } catch {} }
                    else { const ctx = this.canvas.getContext('2d'); if (ctx) { try { ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height); } catch {} } }
                  } catch {}
                  finally { try { frame.close(); } catch {} this.stats.framesDrawn++; try { this._markActivity(); } catch {} }
                };
                try {
                  const ptsUs = typeof frame.timestamp === 'number' ? this.normalizeTsToUs(frame.timestamp) : undefined;
                  // 若尚无音频/PCR 时钟，且未建立视频墙钟基准，则用首个输出帧建立基准
                  if (ptsUs !== undefined && this.audioBasePtsUs === undefined && this.pcrBasePtsUs === undefined && (this.videoBasePtsUs === undefined || this.videoBaseTime === undefined)) {
                    this.videoBasePtsUs = ptsUs;
                    this.videoBaseTime = performance.now() / 1000;
                    try { if ((window as any).__DEMO_DEBUG) console.warn('[clock] video wall-clock base set from output ts(us)=', ptsUs); } catch {}
                  }
                  if (ptsUs !== undefined && this.lastVideoPtsUs !== undefined && ptsUs < this.lastVideoPtsUs) {
                    try { frame.close(); } catch {}
                    this.videoReadyForDeltas = true;
                    return;
                  }
                  const drawWithUpdate = () => { doDraw(); if (ptsUs !== undefined) this.lastVideoPtsUs = ptsUs; };
                  if (ptsUs !== undefined && this.audioBasePtsUs !== undefined && this.audioBaseTime !== undefined && this.audioCtx) {
                    const targetS = this.audioBaseTime + this.US_TO_S(ptsUs - this.audioBasePtsUs) / Math.max(0.01, this.playbackRate);
                    const nowS = this.audioCtx.currentTime;
            const delayMs = Math.max(0, (targetS - nowS) * 1000);
                    if (delayMs > 1) setTimeout(drawWithUpdate, Math.min(delayMs, 50)); else drawWithUpdate();
                  } else { drawWithUpdate(); }
                } catch { doDraw(); }
                this.videoReadyForDeltas = true;
              },
              error: (e: any) => {
                try { this.videoDecodeErrorStreak = (this.videoDecodeErrorStreak || 0) + 1; } catch {}
                console.error('VideoDecoder error', e, 'streak=', this.videoDecodeErrorStreak);
                try { this.videoReadyForDeltas = false; while (this.videoDecodeQueue.length && !this.videoDecodeQueue[0].key) { this.videoDecodeQueue.shift(); this.stats.framesDropped++; } } catch {}
                try { if (this.videoDecodeErrorStreak >= this.decodeErrorThreshold) { this.videoDecodeErrorStreak = 0; this._requestKeyFromWorker(); } } catch {}
              }
            });
            const cfg: any = { codec: msg.video.codec || 'avc1.42E01E', optimizeForLatency: true };
            try { (cfg as any).hardwareAcceleration = 'prefer-hardware'; } catch {}
            // 若标记为 AnnexB，忽略 description，避免与 AnnexB 裸流冲突
            const isAnnexB = !!(msg.video as any).annexb;
            if (!isAnnexB && msg.video.description) cfg.description = msg.video.description;
            // 同步缓存新的参数集（若提供了 avcC/description）
            try { if (msg.video.description) this._cacheSpsPpsFromAvcC(msg.video.description); } catch {}
            try { if ((window as any).__DEMO_DEBUG) console.debug('[vcfg] reconfig video annexb=', isAnnexB, 'codec=', cfg.codec, 'desc?', !!cfg.description); } catch {}
            try {
              const Ctor: any = (window as any).VideoDecoder;
              if (Ctor.isConfigSupported) {
                Ctor.isConfigSupported(cfg).then((res: any) => {
                  try { this.videoDecoder.configure(res?.config || cfg); } catch(e) { this.videoDecoder.configure(cfg); }
                }).catch(() => { this.videoDecoder.configure(cfg); });
              } else {
                this.videoDecoder.configure(cfg);
              }
            } catch { this.videoDecoder.configure(cfg); }
          } catch(e) {
            console.warn('Video reconfigure failed', e);
            if (this.enableSoftwareFallback) {
              try { this.softwareVideoActive = true; console.warn('[fallback] switching to software video decode (stub)'); } catch {}
            }
          }
        }
    if (msg.audio && typeof (window as any).AudioDecoder !== 'undefined') {
          try {
      this.audioConfigured = false;
      if (this.audioDecoder) { try { this.audioDecoder.close(); } catch(e) {} }
            // 复用 ready-mp4 中的 output 逻辑（简化：仅重建配置）
            const ad = new (window as any).AudioDecoder({ output: (frame: any) => {
              try {
                this.audioCtx = this.audioCtx || new (window.AudioContext)();
                const numberOfChannels = (frame.numberOfChannels) || (frame.format && frame.format.channels) || 2;
                const sampleRate = frame.sampleRate || 48000;
                const frameCount = frame.numberOfFrames || frame.frameCount || 0;
                // 如检测到真实采样率与当前配置不一致，则热重配
                try {
                  if (this.audioConfigured && this.audioConfiguredSampleRate && sampleRate && Math.abs(sampleRate - this.audioConfiguredSampleRate) >= 1) {
                    this.audioSampleRateMismatchCount = (this.audioSampleRateMismatchCount || 0) + 1;
                    try { if ((window as any).__DEMO_DEBUG) console.warn('[audio] sampleRate mismatch detected', this.audioConfiguredSampleRate, '->', sampleRate); } catch {}
                    const old = this.audioDecoder; this.audioDecoder = undefined; this.audioConfigured = false;
                    try { old?.close?.(); } catch {}
                    const ad2 = new (window as any).AudioDecoder({
                      output: (f2: any) => {
                        try {
                          const nCh = (f2.numberOfChannels) || 2;
                          const sR = f2.sampleRate || sampleRate;
                          const fcnt = f2.numberOfFrames || 0;
                          let framePtsUs2: number | undefined = undefined;
                          if (typeof f2.timestamp === 'number') framePtsUs2 = this.normalizeTsToUs(f2.timestamp);
                          this._ensureAudioGraph();
                          const abuf = this.audioCtx!.createBuffer(nCh, fcnt, sR);
                          for (let ch = 0; ch < nCh; ch++) { const cd = new Float32Array(fcnt); try { f2.copyTo(cd, { planeIndex: ch }); } catch { f2.copyTo(cd); } abuf.copyToChannel(cd, ch, 0); }
                          const src2 = this.audioCtx!.createBufferSource(); src2.buffer = abuf; src2.connect(this.gainNode!);
                          this._registerAudioSource(src2);
                          try { (src2 as any).playbackRate.value = this.playbackRate; } catch {}
                          if (this.audioBasePtsUs !== undefined && framePtsUs2 !== undefined && this.audioBaseTime !== undefined) {
                            const offsetS = this.US_TO_S(framePtsUs2 - this.audioBasePtsUs);
                            const when = Math.max(this.audioCtx!.currentTime, this.audioBaseTime + offsetS);
                            const now = this.audioCtx!.currentTime; const durS = (fcnt / sR) / Math.max(0.01, this.playbackRate);
                            if (when <= now + 0.02) { src2.start(); this.audioScheduledUntilS = Math.max(this.audioScheduledUntilS, now + durS); } else { try { src2.start(when); } catch { src2.start(); } this.audioScheduledUntilS = Math.max(this.audioScheduledUntilS, when + durS); }
                            try { this._markActivity(); } catch {}
                          } else { src2.start(); }
                        } catch {}
                        finally { try { f2.close(); } catch {} }
                      },
                      error: (e: any) => console.error('AudioDecoder error (reconfig)', e)
                    });
                    const nChCfg = this.audioConfiguredChannels || numberOfChannels;
                    const cfg2: any = { codec: this.audioLastCodec || 'mp4a.40.2', numberOfChannels: nChCfg, sampleRate: sampleRate };
                    if (this.audioLastDescription) cfg2.description = this.audioLastDescription;
                    try { const ACtor: any = (window as any).AudioDecoder; if (ACtor.isConfigSupported) { ACtor.isConfigSupported(cfg2).then((res: any) => { try { ad2.configure(res?.config || cfg2); } catch { ad2.configure(cfg2); } }).catch(() => { ad2.configure(cfg2); }); } else { ad2.configure(cfg2); } } catch { ad2.configure(cfg2); }
                    this.audioDecoder = ad2; this.audioConfigured = true; this.audioConfiguredSampleRate = sampleRate; this.audioConfiguredChannels = nChCfg;
                    try { if ((window as any).__DEMO_DEBUG) console.warn('[audio] hot reconfig to sampleRate=', sampleRate); } catch {}
                  }
                } catch {}
                let framePtsUs: number | undefined = undefined;
                if (typeof frame.timestamp === 'number') framePtsUs = this.normalizeTsToUs(frame.timestamp);
                if (framePtsUs !== undefined && this.audioBasePtsUs === undefined) {
                  this.audioBasePtsUs = 0; this.audioBaseTime = this.audioCtx.currentTime + 0.20;
                  this.pcrBasePtsUs = undefined; this.pcrBaseTime = undefined;
                  this.videoBasePtsUs = undefined; this.videoBaseTime = undefined;
                  try { if ((window as any).__DEMO_DEBUG) console.debug('[clock] audio base set (zero) at', this.audioBaseTime); } catch {}
                }
                const audioBuffer = this.audioCtx.createBuffer(numberOfChannels, frameCount, sampleRate);
                for (let ch = 0; ch < numberOfChannels; ch++) {
                  const channelData = new Float32Array(frameCount);
                  try { frame.copyTo(channelData, { planeIndex: ch }); } catch { frame.copyTo(channelData); }
                  audioBuffer.copyToChannel(channelData, ch, 0);
                }
                this._ensureAudioGraph();
                const src = this.audioCtx.createBufferSource(); src.buffer = audioBuffer; src.connect(this.gainNode!);
                this._registerAudioSource(src);
                if (this.audioBasePtsUs !== undefined && framePtsUs !== undefined && this.audioBaseTime !== undefined) {
                  const offsetS = this.US_TO_S(framePtsUs - (this.audioBasePtsUs ?? 0)) / Math.max(0.01, this.playbackRate);
                  const when = Math.max(this.audioCtx.currentTime, this.audioBaseTime + offsetS); const now = this.audioCtx.currentTime;
                  const durS = (frameCount / sampleRate) / Math.max(0.01, this.playbackRate);
                  if (when <= now + 0.02) { src.start(); this.audioScheduledUntilS = Math.max(this.audioScheduledUntilS, now + durS); }
                  else { try { src.start(when); } catch { src.start(); } this.audioScheduledUntilS = Math.max(this.audioScheduledUntilS, when + durS); }
                  try { (src as any).playbackRate.value = this.playbackRate; } catch {}
                  try { this._markActivity(); } catch {}
                } else {
                  src.start();
                  if (framePtsUs !== undefined && this.audioBasePtsUs === undefined) {
                    this.audioBasePtsUs = 0; this.audioBaseTime = this.audioCtx.currentTime; this.pcrBasePtsUs = undefined; this.pcrBaseTime = undefined; this.videoBasePtsUs = undefined; this.videoBaseTime = undefined;
                    try { if ((window as any).__DEMO_DEBUG) console.debug('[clock] audio base set (zero) at', this.audioBaseTime); } catch {}
                  }
                }
              } catch (e) { console.warn('AudioDecoder output handling failed', e); } finally { try { frame.close(); } catch {} }
            }, error: (e: any) => { console.error('AudioDecoder error', e); try { this.emit('error', e); } catch {} } });
            const cfg: any = { codec: msg.audio.codec || 'mp4a.40.2' };
            if (msg.audio.description) cfg.description = msg.audio.description;
            // numberOfChannels and sampleRate are required for AudioDecoder configuration
            cfg.numberOfChannels = msg.audio.numberOfChannels ?? 2;
            cfg.sampleRate = msg.audio.sampleRate ?? 48000;
            try {
              const ACtor: any = (window as any).AudioDecoder;
              if (ACtor.isConfigSupported) {
                ACtor.isConfigSupported(cfg).then((res: any) => {
                  try { ad.configure(res?.config || cfg); } catch(e) { ad.configure(cfg); }
                }).catch(() => { ad.configure(cfg); });
              } else {
                ad.configure(cfg);
              }
            } catch { ad.configure(cfg); }
            this.audioDecoder = ad;
            this.audioConfigured = true;
          } catch(e) { console.warn('Audio reconfigure failed', e); }
        }
        break;
      case 'log':
        try {
          const msgStr = String(msg.msg ?? '');
          // 控制台输出
          // 使用 console.debug 降低噪音；可通过 window.__DEMO_DEBUG 控制
          if ((window as any).__DEMO_DEBUG) console.info('[worker]', msgStr);
          else console.debug('[worker]', msgStr);
          // 页面日志面板（webcodes.html）
          try {
            const el = document.getElementById('consoleLog');
            if (el) {
              const line = document.createElement('div');
              line.textContent = msgStr;
              el.appendChild(line);
              // 滚动到底
              el.scrollTop = el.scrollHeight;
            }
          } catch {}
        } catch {}
        break;
      default:
        // ...existing code...
    }
  }
}
