var DemoBundle = (function () {
  'use strict';

  /**
   * PlayerCore - 主线程播放器内核门面（骨架）
   * 负责 lifecycle、解码器管理、与 worker 通信、渲染队列。
   */
  class PlayerCore {
      _applyPlaybackRateToSources() {
          try {
              for (const s of this.audioSources) {
                  try {
                      (s.playbackRate && s.playbackRate.value !== undefined) && ((s.playbackRate.value = this.playbackRate));
                  }
                  catch { }
              }
          }
          catch { }
      }
      // 事件注册
      on(event, cb) {
          if (!this.eventListeners[event])
              this.eventListeners[event] = [];
          this.eventListeners[event].push(cb);
      }
      off(event, cb) {
          const arr = this.eventListeners[event];
          if (!arr)
              return;
          const i = arr.indexOf(cb);
          if (i >= 0)
              arr.splice(i, 1);
      }
      once(event, cb) {
          const wrap = (...args) => { try {
              cb(...args);
          }
          finally {
              this.off(event, wrap);
          } };
          this.on(event, wrap);
      }
      // 事件分发
      emit(event, ...args) {
          (this.eventListeners[event] || []).forEach(fn => { try {
              fn(...args);
          }
          catch (e) { } });
      }
      // 检查 WebCodecs 支持
      isWebCodecsSupported() {
          return typeof window.VideoDecoder !== 'undefined' && typeof window.AudioDecoder !== 'undefined';
      }
      // 软解接口占位（WASM）
      decodeVideoWASM(chunk) {
          // TODO: 调用 WASM 解码库（如 ffmpeg.wasm），返回解码后帧
          console.warn('WASM软解未实现，当前仅为接口占位');
      }
      decodeAudioWASM(chunk) {
          // TODO: 调用 WASM 解码库，返回解码后 PCM
          console.warn('WASM软解未实现，当前仅为接口占位');
      }
      normalizeTsToUs(ts) {
          // 启发式：> ~50 分钟（3e9）视为 90kHz tick，转换为微秒；否则按微秒处理
          try {
              if (!Number.isFinite(ts))
                  return ts;
              return (ts > 3e9) ? Math.round(ts * (1e6 / 90000)) : Math.round(ts);
          }
          catch {
              return ts;
          }
      }
      // 工具：检测 AnnexB 起始码
      _isAnnexB(buf) {
          try {
              const u = new Uint8Array(buf);
              if (u.length < 4)
                  return false;
              // 支持 00 00 01 或 00 00 00 01
              return (u[0] === 0 && u[1] === 0 && ((u[2] === 1) || (u[2] === 0 && u[3] === 1)));
          }
          catch {
              return false;
          }
      }
      // 工具：将 AVCC（自适应 1/2/4 字节长度前缀）转换为 AnnexB（起始码）
      _avccToAnnexB(buf) {
          try {
              const u8 = new Uint8Array(buf);
              if (u8.length < 1)
                  return buf;
              const tryParse = (lenSize) => {
                  const chunks = [];
                  let off = 0;
                  while (off + lenSize <= u8.length) {
                      let len = 0;
                      if (lenSize === 4) {
                          len = (u8[off] << 24) | (u8[off + 1] << 16) | (u8[off + 2] << 8) | (u8[off + 3]);
                      }
                      else if (lenSize === 2) {
                          len = (u8[off] << 8) | (u8[off + 1]);
                      }
                      else { // 1
                          len = u8[off];
                      }
                      off += lenSize;
                      if (len <= 0 || off + len > u8.length)
                          return null;
                      chunks.push(new Uint8Array([0, 0, 0, 1]));
                      chunks.push(u8.subarray(off, off + len));
                      off += len;
                  }
                  if (off !== u8.length || chunks.length === 0)
                      return null;
                  let total = 0;
                  for (const c of chunks)
                      total += c.length;
                  const out = new Uint8Array(total);
                  let p = 0;
                  for (const c of chunks) {
                      out.set(c, p);
                      p += c.length;
                  }
                  return out.buffer;
              };
              return tryParse(4) || tryParse(2) || tryParse(1) || buf;
          }
          catch {
              return buf;
          }
      }
      // 扫描 AnnexB，缓存 SPS/PPS，返回是否检测到
      _scanAndCacheSpsPpsFromAnnexB(buf) {
          try {
              const u8 = new Uint8Array(buf);
              const starts = [];
              // 找到所有起始码位置
              for (let i = 0; i + 3 < u8.length; i++) {
                  if (u8[i] === 0 && u8[i + 1] === 0 && ((u8[i + 2] === 1) || (u8[i + 2] === 0 && u8[i + 3] === 1))) {
                      starts.push(i);
                      if (u8[i + 2] === 1)
                          i += 2;
                      else
                          i += 3; // 跳过起始码长度
                  }
              }
              if (starts.length === 0)
                  return { hasSps: false, hasPps: false };
              // 计算每个 NAL 的边界
              const bounds = [];
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
                  if (b.type === 7) {
                      hasSps = true;
                      this._lastSpsUnits = [u8.subarray(b.off, b.off + b.len)];
                  }
                  if (b.type === 8) {
                      hasPps = true;
                      this._lastPpsUnits = [u8.subarray(b.off, b.off + b.len)];
                  }
              }
              return { hasSps, hasPps };
          }
          catch {
              return { hasSps: false, hasPps: false };
          }
      }
      // 若关键帧缺少 SPS/PPS，则用缓存注入（AnnexB 格式）
      _ensureSpsPpsForKeyAnnexB(buf) {
          try {
              const found = this._scanAndCacheSpsPpsFromAnnexB(buf);
              if (found.hasSps && found.hasPps)
                  return buf;
              const needSps = !found.hasSps && this._lastSpsUnits.length > 0;
              const needPps = !found.hasPps && this._lastPpsUnits.length > 0;
              if (!needSps && !needPps)
                  return buf;
              const u8 = new Uint8Array(buf);
              let extraLen = 0;
              if (needSps)
                  for (const s of this._lastSpsUnits)
                      extraLen += s.length;
              if (needPps)
                  for (const p of this._lastPpsUnits)
                      extraLen += p.length;
              const out = new Uint8Array(extraLen + u8.length);
              let p = 0;
              if (needSps) {
                  for (const s of this._lastSpsUnits) {
                      out.set(s, p);
                      p += s.length;
                  }
              }
              if (needPps) {
                  for (const q of this._lastPpsUnits) {
                      out.set(q, p);
                      p += q.length;
                  }
              }
              out.set(u8, p);
              return out.buffer;
          }
          catch {
              return buf;
          }
      }
      // 从 avcC extradata 提取 SPS/PPS 并缓存（便于后续 AnnexB 注入）
      _cacheSpsPpsFromAvcC(desc) {
          try {
              const u = new Uint8Array(desc);
              if (u.length < 7)
                  return;
              let off = 0;
              // 跳过头部 5 字节：version, profile, compat, level, lengthSizeMinusOne
              off = 5;
              const numSps = u[off++] & 0x1f;
              const spsUnits = [];
              for (let i = 0; i < numSps; i++) {
                  if (off + 2 > u.length)
                      return;
                  const len = (u[off] << 8) | u[off + 1];
                  off += 2;
                  if (off + len > u.length)
                      return;
                  // 组装 AnnexB：起始码 + NAL
                  const out = new Uint8Array(4 + len);
                  out.set([0, 0, 0, 1], 0);
                  out.set(u.subarray(off, off + len), 4);
                  spsUnits.push(out);
                  off += len;
              }
              if (off >= u.length) {
                  this._lastSpsUnits = spsUnits;
                  return;
              }
              const numPps = u[off++];
              const ppsUnits = [];
              for (let i = 0; i < numPps; i++) {
                  if (off + 2 > u.length)
                      break;
                  const len = (u[off] << 8) | u[off + 1];
                  off += 2;
                  if (off + len > u.length)
                      break;
                  const out = new Uint8Array(4 + len);
                  out.set([0, 0, 0, 1], 0);
                  out.set(u.subarray(off, off + len), 4);
                  ppsUnits.push(out);
                  off += len;
              }
              if (spsUnits.length)
                  this._lastSpsUnits = spsUnits;
              if (ppsUnits.length)
                  this._lastPpsUnits = ppsUnits;
          }
          catch { /* ignore */ }
      }
      _registerAudioSource(src) {
          try {
              this.audioSources.add(src);
              const cleanup = () => { try {
                  src.disconnect();
              }
              catch { } this.audioSources.delete(src); };
              // ended 事件在部分实现中可用；若不可用也不致命
              src.addEventListener?.('ended', cleanup);
              // 兜底：在 stop/seek/discontinuity 中统一清理
          }
          catch { }
      }
      _stopAllAudioSources() {
          try {
              for (const s of Array.from(this.audioSources)) {
                  try {
                      s.stop();
                  }
                  catch { }
                  try {
                      s.disconnect();
                  }
                  catch { }
                  this.audioSources.delete(s);
              }
          }
          catch { }
      }
      // 计算当前音频主钟对应的 PTS（us）。若基准未建立，返回 undefined
      _getAudioNowUs() {
          if (!this.audioCtx || this.audioBasePtsUs === undefined || this.audioBaseTime === undefined)
              return undefined;
          const nowS = this.audioCtx.currentTime;
          const deltaS = nowS - this.audioBaseTime;
          return this.audioBasePtsUs + Math.max(0, deltaS) * 1e6;
      }
      // 轻量：尝试解锁 AudioContext（在需要时调用，不阻塞主流程）
      _ensureAudioUnlocked() {
          try {
              if (!this.audioCtx)
                  return;
              const st = String(this.audioCtx.state || '');
              if (st === 'suspended' || st === 'interrupted') {
                  this.audioCtx.resume().catch(() => { });
              }
          }
          catch { }
      }
      // 平滑调节当前播放速率，逐步靠近 targetPlaybackRate
      _ensurePlaybackRateTimer() {
          try {
              if (this.playbackRateTimer)
                  return;
              this.playbackRateTimer = window.setInterval(() => {
                  const step = 0.01;
                  if (Math.abs(this.playbackRate - this.targetPlaybackRate) <= step) {
                      this.playbackRate = this.targetPlaybackRate;
                      if (this.playbackRateTimer) {
                          window.clearInterval(this.playbackRateTimer);
                          this.playbackRateTimer = undefined;
                      }
                      this._applyPlaybackRateToSources();
                      return;
                  }
                  if (this.playbackRate < this.targetPlaybackRate)
                      this.playbackRate = Math.min(this.targetPlaybackRate, this.playbackRate + step);
                  else
                      this.playbackRate = Math.max(this.targetPlaybackRate, this.playbackRate - step);
                  this._applyPlaybackRateToSources();
              }, 50);
          }
          catch { }
      }
      // 统一获取当前播放时钟（优先音频，其次可选 PCR）
      _getClockNowUs() {
          const a = this._getAudioNowUs();
          if (a !== undefined)
              return a;
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
      _renderVideoFrame() {
          if (!this.videoDecoder) {
              try {
                  if (window.__DEMO_DEBUG)
                      console.debug('[v] no decoder');
              }
              catch { }
              return;
          }
          if (this.videoDecodeQueue.length === 0) {
              try {
                  if (window.__DEMO_DEBUG)
                      console.debug('[v] queue empty');
              }
              catch { }
              return;
          }
          try {
              if (window.__DEMO_DEBUG)
                  console.debug('[v] queue size=', this.videoDecodeQueue.length, 'readyForDeltas=', this.videoReadyForDeltas);
          }
          catch { }
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
                      if (!this._isAnnexB(payload))
                          payload = this._avccToAnnexB(payload);
                      // 若为关键帧，缺失参数集则从缓存注入 SPS/PPS
                      try {
                          payload = this._ensureSpsPpsForKeyAnnexB(payload);
                      }
                      catch { }
                      const init = { type: 'key', timestamp: tsSafe, data: payload };
                      if (typeof firstK.dur === 'number' && firstK.dur > 0)
                          init.duration = Number(firstK.dur) || undefined;
                      const chunk = new window.EncodedVideoChunk(init);
                      if (window.__DEMO_DEBUG) {
                          try {
                              console.debug('[feed] early key -> ts(us)=', tsSafe);
                          }
                          catch { }
                      }
                      this.videoDecoder.decode(chunk);
                      try {
                          this._markActivity();
                      }
                      catch { }
                      // 一旦送入关键帧，允许后续 delta 帧进入，避免解码器饿死
                      this.videoReadyForDeltas = true;
                      // 额外引导：在关键帧之后解码少量相邻 delta（<=200ms 或最多 8 帧），帮助尽快进入稳态
                      const limitUs = tsSafe + this.__bootstrapLimitUs;
                      let fed = 0;
                      for (let i = 0; i < this.videoDecodeQueue.length && fed < this.__bootstrapMax;) {
                          const n = this.videoDecodeQueue[i];
                          if ((n.dts ?? n.ts) <= limitUs && !n.key) {
                              this.videoDecodeQueue.splice(i, 1);
                              try {
                                  const nts = Math.max(0, Number(n.ts) || 0);
                                  // 同样保证 AnnexB
                                  let npayload = n.data;
                                  if (!this._isAnnexB(npayload))
                                      npayload = this._avccToAnnexB(npayload);
                                  const ninit = { type: 'delta', timestamp: nts, data: npayload };
                                  if (typeof n.dur === 'number' && n.dur > 0)
                                      ninit.duration = Number(n.dur) || undefined;
                                  const nchunk = new window.EncodedVideoChunk(ninit);
                                  if (window.__DEMO_DEBUG) {
                                      try {
                                          console.debug('[feed] bootstrap delta ts(us)=', nts);
                                      }
                                      catch { }
                                  }
                                  this.videoDecoder.decode(nchunk);
                                  try {
                                      this._markActivity();
                                  }
                                  catch { }
                                  fed++;
                              }
                              catch { }
                          }
                          else {
                              i++;
                          }
                      }
                  }
                  catch { }
              }
              return;
          }
          // 1) 丢弃严重落后的帧（按 PTS 比较）
          const dropBeforeUs = audioNowUs - this.__dropWindowUs;
          if (this.videoDecodeQueue.length > 0) {
              while (this.videoDecodeQueue.length > 0) {
                  const head = this.videoDecodeQueue[0];
                  const headPtsUs = head.ts;
                  if (headPtsUs < dropBeforeUs && this.videoDecodeQueue.length > 2) {
                      this.videoDecodeQueue.shift();
                      this.stats.framesDropped++;
                  }
                  else {
                      break;
                  }
              }
          }
          // 2) 预解码：按 DTS 顺序尽量把解码队列喂满（避免 B 帧引用阻塞），用 in-flight 数限制控制前瞻深度
          // 控制解码排队深度，避免无穷积压。多数实现提供 decodeQueueSize。
          const vdec = this.videoDecoder;
          const maxInFlight = this.__maxVideoInFlight;
          while (this.videoDecodeQueue.length > 0 && ((vdec.decodeQueueSize ?? 0) < maxInFlight)) {
              const next = this.videoDecodeQueue.shift();
              try {
                  // 在首帧成功输出前，跳过 delta 帧，避免解码器依赖未满足
                  if (!this.videoReadyForDeltas && !next.key) {
                      continue;
                  }
                  // 控制预解码窗口：仅在音频时基可用时，限制喂入距离音频时钟的前瞻深度
                  if (audioNowUs !== undefined && next.ts > audioNowUs + this.__lookAheadUs) {
                      // 放回队头，等待时钟前进
                      this.videoDecodeQueue.unshift(next);
                      break;
                  }
                  const tsSafe = Math.max(0, Number(next.ts) || 0);
                  // 确保 AnnexB：如检测为 AVCC 则转换
                  let payload = next.data;
                  if (!this._isAnnexB(payload))
                      payload = this._avccToAnnexB(payload);
                  if (next.key) {
                      try {
                          payload = this._ensureSpsPpsForKeyAnnexB(payload);
                      }
                      catch { }
                  }
                  const init = { type: next.key ? 'key' : 'delta', timestamp: tsSafe, data: payload };
                  if (typeof next.dur === 'number' && next.dur > 0)
                      init.duration = Number(next.dur) || undefined;
                  const chunk = new window.EncodedVideoChunk(init);
                  if (window.__DEMO_DEBUG) {
                      try {
                          console.debug('[feed]', init.type, 'ts(us)=', tsSafe);
                      }
                      catch { }
                  }
                  this.videoDecoder.decode(chunk);
                  try {
                      this._markActivity();
                  }
                  catch { }
                  if (next.key)
                      this.videoReadyForDeltas = true;
              }
              catch (e) { /* 解码错误时忽略该帧 */ }
          }
      }
      constructor(opts) {
          // 播放控制状态
          this.isPlaying = false;
          this.playbackRate = 1.0; // 当前生效速率（平滑趋近目标）
          this.targetPlaybackRate = 1.0; // 目标速率
          this.eventListeners = {};
          this.generationId = 0;
          // Timebase helpers: we use microseconds (us) internally for sample timestamps
          this.US_TO_S = (us) => us / 1e6;
          this.MS_TO_US = (ms) => ms * 1000;
          this.__lookAheadUs = 80000; // 80ms，适当增加前瞻，缓解音频抖动
          this.__dropWindowUs = 120000; // 120ms，降低卡顿
          // 视频绘制“超前阈值”，当视频帧相对音频主钟超前超过此值时，选择不再等待直接绘制一次（以保证画面活性）
          // 注意：这是“可见性优先”的策略，若严格追求唇同步，可将其调小直至 0
          this.__leadWindowUs = 200000; // 200ms
          this.__maxVideoInFlight = 6; // 初始 in-flight 限制更紧
          this.__maxVideoQueue = 180; // 初始排队更短，减小首段积压
          // 启动期引导：首个关键帧后，在一定窗口内（us）额外喂入少量 delta 帧，尽快稳态
          this.__bootstrapLimitUs = 500000; // 500ms
          this.__bootstrapMax = 20; // 最多 20 帧
          this.stallMinAudioAheadS = 0.03;
          this.stallNoAudioIdleMs = 500;
          // 缓存最近的 SPS/PPS（AnnexB NAL 单元，包含起始码）
          this._lastSpsUnits = [];
          this._lastPpsUnits = [];
          this.usePcrBeforeAudio = false;
          this.videoDescAttached = false;
          this.firstVideoSeen = false;
          this.annexbDetected = false;
          // 连续时间轴（跨 discontinuity/seek 维持 UI 连续）；单位：微秒
          this.continuousTimeline = true;
          this.timelineOffsetUs = 0;
          // 已计划播放的音频节点，便于在 seek/stop/discontinuity 时统一停止
          this.audioSources = new Set();
          this.videoReadyForDeltas = false;
          this.enableSoftwareFallback = false;
          this.softwareVideoActive = false;
          this.softwareAudioActive = false;
          // 解码队列：按解码顺序（DTS 优先，缺失时回退 PTS）排列，仅存待送入解码器的样本
          this.videoDecodeQueue = [];
          this.audioConfigured = false;
          this.audioQueue = [];
          this.lastWasPlaying = false;
          // 简单运行指标
          this.stats = { framesDrawn: 0, framesDropped: 0 };
          this.muted = false;
          this.volume = 1;
          // 缓冲/卡顿检测：跟踪音频已调度的最远结束时间（秒）与最近活动时间（毫秒）
          this.audioScheduledUntilS = 0;
          this.lastActivityTsMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
          this.lastBufferingState = false;
          this.canvas = opts.canvas;
          // 默认启用 PCR 作为临时时钟（可被 opts 覆盖）
          this.usePcrBeforeAudio = (typeof opts.usePcrBeforeAudio === 'boolean') ? opts.usePcrBeforeAudio : true;
          this.enableSoftwareFallback = !!opts.enableSoftwareFallback;
          if (typeof opts.videoLookAheadMs === 'number')
              this.__lookAheadUs = this.MS_TO_US(opts.videoLookAheadMs);
          if (typeof opts.dropWindowMs === 'number')
              this.__dropWindowUs = this.MS_TO_US(opts.dropWindowMs);
          if (typeof opts.leadWindowMs === 'number')
              this.__leadWindowUs = this.MS_TO_US(opts.leadWindowMs);
          if (typeof opts.maxVideoInFlight === 'number')
              this.__maxVideoInFlight = Math.max(1, Math.floor(opts.maxVideoInFlight));
          if (typeof opts.maxVideoQueue === 'number')
              this.__maxVideoQueue = Math.max(30, Math.floor(opts.maxVideoQueue));
          if (typeof opts.stallAudioMinAheadS === 'number')
              this.stallMinAudioAheadS = Math.max(0, Number(opts.stallAudioMinAheadS));
          if (typeof opts.stallNoAudioIdleMs === 'number')
              this.stallNoAudioIdleMs = Math.max(0, Math.floor(opts.stallNoAudioIdleMs));
          try {
              const want = opts.renderer || '2d';
              if (want === 'webgl') {
                  try {
                      // eslint-disable-next-line @typescript-eslint/no-var-requires
                      const ModGL = require('./renderer-webgl');
                      this.renderer2D = new ModGL.RendererWebGL(this.canvas);
                  }
                  catch { /* fallback to 2D */
                      // eslint-disable-next-line @typescript-eslint/no-var-requires
                      const Mod2D = require('./renderer-2d');
                      this.renderer2D = new Mod2D.Renderer2D(this.canvas);
                  }
              }
              else {
                  // eslint-disable-next-line @typescript-eslint/no-var-requires
                  const Mod2D = require('./renderer-2d');
                  this.renderer2D = new Mod2D.Renderer2D(this.canvas);
              }
          }
          catch { /* ignore if module system differs */ }
          // 周期性输出运行指标（仅在 __DEMO_DEBUG 时启用）
          try {
              if (!this.statsTimer)
                  this.statsTimer = window.setInterval(() => {
                      if (window.__DEMO_DEBUG) {
                          try {
                              console.debug('[stats]', { ...this.stats, vq: this.videoDecodeQueue.length });
                          }
                          catch { }
                      }
                  }, 1000);
          }
          catch { }
          // 启动卡顿/缓冲状态监测
          this._ensureStallMonitor();
          // 轻量用户手势解锁音频（一次性）
          try {
              const el = this.canvas;
              if (el && !el.__unlockHooked) {
                  const unlock = () => { try {
                      this._ensureAudioUnlocked();
                  }
                  catch { } };
                  el.addEventListener('pointerdown', unlock, { passive: true });
                  el.addEventListener('click', unlock, { passive: true });
                  el.__unlockHooked = true;
                  el.__unlockHandler = unlock;
              }
          }
          catch { }
          // 页面可见性自适应：隐藏时降低渲染频率，显示时恢复
          try {
              const visHandler = () => {
                  try {
                      const hidden = document.hidden;
                      if (hidden) {
                          if (this.renderTimer) {
                              window.clearInterval(this.renderTimer);
                              this.renderTimer = undefined;
                          }
                          this.renderTimer = window.setInterval(() => this._renderVideoFrame(), 100);
                      }
                      else {
                          if (this.renderTimer) {
                              window.clearInterval(this.renderTimer);
                              this.renderTimer = undefined;
                          }
                          this.renderTimer = window.setInterval(() => this._renderVideoFrame(), 10);
                      }
                  }
                  catch { }
              };
              if (!window.__pc_vis_hooked) {
                  document.addEventListener('visibilitychange', visHandler);
                  window.__pc_vis_hooked = true;
                  window.__pc_vis_handler = visHandler;
              }
          }
          catch { }
      }
      async load(url) {
          // 新会话前重置时基与队列，避免继承旧会话时间轴
          this.videoDecodeQueue = [];
          this.audioQueue = [];
          this.audioBasePtsUs = undefined;
          this.audioBaseTime = undefined;
          this.pcrBasePtsUs = undefined;
          this.pcrBaseTime = undefined;
          this.videoBasePtsUs = undefined;
          this.videoBaseTime = undefined;
          this.mediaEpochUs = undefined;
          this.videoReadyForDeltas = false;
          // 新会话开始重置连续时间轴
          this.timelineOffsetUs = 0;
          // 重置音频调度地平线
          this.audioScheduledUntilS = 0;
          this._stopAllAudioSources();
          if (!this.worker)
              this._setupWorker();
          this.generationId++;
          const type = url.endsWith('.m3u8') ? 'openHLS' : (url.endsWith('.flv') ? 'openFLV' : 'open');
          this.lastSource = { kind: type === 'openHLS' ? 'hls' : (type === 'openFLV' ? 'flv' : 'mp4-url'), url };
          if (type === 'openHLS') {
              const startSeq = (typeof this.lastHlsSeq === 'number') ? Math.max(0, this.lastHlsSeq) : undefined;
              const startAtMs = (typeof this.startPositionMs === 'number') ? Math.max(0, this.startPositionMs) : undefined;
              this.worker?.postMessage({ type, url, startSeq, startAtMs, generationId: this.generationId });
          }
          else {
              this.worker?.postMessage({ type, url, generationId: this.generationId });
          }
      }
      async play() {
          this.isPlaying = true;
          this.lastWasPlaying = true;
          this.emit('playing');
          if (this.audioCtx) {
              const st = String(this.audioCtx.state || '');
              if (st === 'suspended' || st === 'interrupted') {
                  await this.audioCtx.resume();
              }
          }
          this._ensureAudioUnlocked();
          if (!this.renderTimer) {
              this.renderTimer = window.setInterval(() => this._renderVideoFrame(), 10);
          }
      }
      async pause() {
          this.isPlaying = false;
          this.lastWasPlaying = false;
          this.emit('buffering');
          if (this.audioCtx && String(this.audioCtx.state) === 'running') {
              await this.audioCtx.suspend();
          }
          if (this.renderTimer) {
              window.clearInterval(this.renderTimer);
              this.renderTimer = undefined;
          }
      }
      async stop() {
          this.isPlaying = false;
          this.lastWasPlaying = false;
          this.emit('ended');
          // 停止所有已调度的音频节点
          this._stopAllAudioSources();
          try {
              await (this.videoDecoder?.flush?.() || Promise.resolve());
          }
          catch { }
          try {
              await (this.audioDecoder?.flush?.() || Promise.resolve());
          }
          catch { }
          try {
              this.videoDecoder?.close?.();
          }
          catch { }
          try {
              this.audioDecoder?.close?.();
          }
          catch { }
          this.videoDecoder = undefined;
          this.audioDecoder = undefined;
          this.audioConfigured = false;
          if (this.audioCtx) {
              await this.audioCtx.close();
              this.audioCtx = undefined;
          }
          if (this.renderTimer) {
              window.clearInterval(this.renderTimer);
              this.renderTimer = undefined;
          }
          // 清空队列、重置状态
          this.videoDecodeQueue = [];
          this.audioQueue = [];
          this.audioBasePtsUs = undefined;
          this.audioBaseTime = undefined;
          this.audioConfigured = false;
          this.videoReadyForDeltas = false;
          this.pcrBasePtsUs = undefined;
          this.pcrBaseTime = undefined;
          this.mediaEpochUs = undefined;
          this.softwareVideoActive = false;
          this.softwareAudioActive = false;
          this.lastVideoPtsUs = undefined;
          this.timelineOffsetUs = 0;
          this.audioScheduledUntilS = 0;
          // 停止卡顿检测
          try {
              if (this.stallTimer) {
                  window.clearInterval(this.stallTimer);
                  this.stallTimer = undefined;
              }
          }
          catch { }
      }
      async seek(ms) {
          // 向 worker 发送 seek 消息
          if (this.worker) {
              // flush + 清空解码队列与时基，等待新的样本建立
              try {
                  await (this.videoDecoder?.flush?.() || Promise.resolve());
              }
              catch { }
              try {
                  await (this.audioDecoder?.flush?.() || Promise.resolve());
              }
              catch { }
              // 停止所有已调度的音频节点
              this._stopAllAudioSources();
              this.videoDecodeQueue = [];
              this.audioQueue = [];
              this.audioBasePtsUs = undefined;
              this.audioBaseTime = undefined;
              this.pcrBasePtsUs = undefined;
              this.pcrBaseTime = undefined;
              this.videoBasePtsUs = undefined;
              this.videoBaseTime = undefined;
              this.mediaEpochUs = undefined;
              this.videoReadyForDeltas = false;
              this.lastVideoPtsUs = undefined;
              this.audioScheduledUntilS = 0;
              this.worker.postMessage({ type: 'seek', ms, generationId: this.generationId });
              this.emit('buffering');
          }
          // 可扩展：清空队列、等待新 sample
          // 连续时间轴：seek 到绝对时间
          if (this.continuousTimeline) {
              this.timelineOffsetUs = Math.max(0, Math.floor(Number(ms) || 0) * 1000);
          }
      }
      // 速率控制
      setPlaybackRate(rate) {
          this.targetPlaybackRate = Math.max(0.25, Math.min(4.0, Number(rate) || 1));
          this._ensurePlaybackRateTimer();
          // 立即应用到当前已调度的音频节点（随后定时器继续平滑靠近）
          this._applyPlaybackRateToSources();
          // 可扩展：视频帧时间戳缩放
      }
      setMuted(m) {
          this.muted = !!m;
          this._applyGain();
      }
      setVolume(v) {
          this.volume = Math.max(0, Math.min(1, Number(v) || 0));
          this._applyGain();
      }
      _ensureAudioGraph() {
          if (!this.audioCtx)
              this.audioCtx = new (window.AudioContext)();
          try {
              // 监听状态变化，出现 suspended/interrupted 时尝试恢复
              const ctx = this.audioCtx;
              if (!ctx.__stateHooked) {
                  this.audioCtx.addEventListener('statechange', () => {
                      try {
                          if (!this.audioCtx)
                              return;
                          const st = String(this.audioCtx.state || '');
                          if (st === 'suspended' || st === 'interrupted')
                              this._ensureAudioUnlocked();
                      }
                      catch { }
                  });
                  ctx.__stateHooked = true;
              }
          }
          catch { }
          if (!this.gainNode && this.audioCtx) {
              this.gainNode = this.audioCtx.createGain();
              this.gainNode.connect(this.audioCtx.destination);
          }
          this._applyGain();
      }
      // 记录最近一次活动（用于卡顿检测）
      _markActivity() { try {
          this.lastActivityTsMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      }
      catch { } }
      // 周期性监测缓冲状态：依据已调度音频提前量与视频队列
      _ensureStallMonitor() {
          try {
              if (this.stallTimer)
                  return;
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
                          }
                          else {
                              const idleMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - (this.lastActivityTsMs || 0);
                              buffering = (vq < 1) && (idleMs > this.stallNoAudioIdleMs);
                          }
                      }
                      if (buffering !== this.lastBufferingState) {
                          this.lastBufferingState = buffering;
                          this.emit(buffering ? 'buffering' : 'playing');
                      }
                  }
                  catch { }
              }, 250);
          }
          catch { }
      }
      _applyGain() {
          if (!this.gainNode)
              return;
          const val = this.muted ? 0 : this.volume;
          try {
              this.gainNode.gain.value = val;
          }
          catch { /* ignore */ }
      }
      async openMP4(initBuffer) {
          if (!this.worker)
              this._setupWorker();
          this.generationId++;
          // send init segment to worker for parsing
          this.lastSource = { kind: 'mp4-init', buffer: initBuffer };
          this.worker?.postMessage({ type: 'openMP4', buffer: initBuffer, generationId: this.generationId }, [initBuffer]);
      }
      // 读取运行时统计数据（浅拷贝，避免外部修改）
      getStats() {
          return { ...this.stats, videoQueue: this.videoDecodeQueue.length };
      }
      // 可 seek 范围：VOD 返回 [0, duration]；LIVE 返回 [0, undefined]
      getSeekable() {
          const dur = this.getDurationMs();
          if (typeof dur === 'number' && dur > 0)
              return { startMs: 0, endMs: dur, isLive: false };
          return { startMs: 0, endMs: undefined, isLive: true };
      }
      // 当前播放时间（毫秒，基于音频或 PCR 时钟）
      getCurrentTimeMs() {
          const nowUs = this._getClockNowUs();
          if (nowUs === undefined || !Number.isFinite(nowUs) || Math.abs(nowUs) > 1e12)
              return undefined;
          const totalUs = this.continuousTimeline ? (this.timelineOffsetUs + nowUs) : nowUs;
          return totalUs / 1000;
      }
      getDurationMs() { return this.mediaDurationMs; }
      // —— 运行时调参 API ——
      // 预解码窗口（毫秒）
      setLookAheadMs(ms) { this.__lookAheadUs = this.MS_TO_US(Math.max(0, Number(ms) || 0)); }
      // 落后丢帧窗口（毫秒）
      setDropWindowMs(ms) { this.__dropWindowUs = this.MS_TO_US(Math.max(0, Number(ms) || 0)); }
      // 超前立即绘制阈值（毫秒）
      setLeadWindowMs(ms) { this.__leadWindowUs = this.MS_TO_US(Math.max(0, Number(ms) || 0)); }
      // 解码器 in-flight 上限
      setMaxVideoInFlight(n) { this.__maxVideoInFlight = Math.max(1, Math.floor(Number(n) || 1)); }
      // 待解码队列上限
      setMaxVideoQueue(n) { this.__maxVideoQueue = Math.max(30, Math.floor(Number(n) || 30)); }
      // 缓冲监控阈值：有音频时的最小“已排程前瞻时间”（秒）与无音频时的空闲阈值（毫秒）
      setStallThresholds(minAudioAheadS, noAudioIdleMs) {
          this.stallMinAudioAheadS = Math.max(0, Number(minAudioAheadS) || 0);
          this.stallNoAudioIdleMs = Math.max(0, Math.floor(Number(noAudioIdleMs) || 0));
      }
      // 设置引导喂入参数
      setBootstrapFeed(limitMs, maxFrames) {
          this.__bootstrapLimitUs = this.MS_TO_US(Math.max(0, Number(limitMs) || 0));
          this.__bootstrapMax = Math.max(0, Math.floor(Number(maxFrames) || 0));
      }
      // 开关：是否在音频未建立前使用 PCR 作为临时时钟
      setUsePcrBeforeAudio(on) { this.usePcrBeforeAudio = !!on; }
      // 开关：是否启用连续时间轴（UI 连续）
      setContinuousTimeline(on) { this.continuousTimeline = !!on; }
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
      getVolume() { return this.volume; }
      getVideoQueueSize() { return this.videoDecodeQueue.length; }
      getAudioConfiguredInfo() { return { sampleRate: this.audioConfiguredSampleRate, channels: this.audioConfiguredChannels }; }
      // 查询：相对音频主钟的当前视频帧漂移估计（us），若无基准返回 undefined
      getVideoDriftUs() {
          try {
              if (!this.audioCtx || this.audioBasePtsUs === undefined || this.audioBaseTime === undefined || this.lastVideoPtsUs === undefined)
                  return undefined;
              const nowS = this.audioCtx.currentTime;
              const nowMediaUs = this.audioBasePtsUs + Math.max(0, (nowS - this.audioBaseTime)) * 1e6 * Math.max(0.01, this.playbackRate);
              return this.lastVideoPtsUs - nowMediaUs;
          }
          catch {
              return undefined;
          }
      }
      // 查询：是否认为处于缓冲中（来自最近一次评估）
      isBuffering() { return !!this.lastBufferingState; }
      setStartPositionMs(ms) { this.startPositionMs = (typeof ms === 'number' && ms >= 0) ? Math.floor(ms) : undefined; }
      // 快速跳到直播尾（HLS live）
      goLive() { try {
          this.worker?.postMessage({ type: 'seek', ms: Number.MAX_SAFE_INTEGER, generationId: this.generationId });
          this.emit('buffering');
      }
      catch { } }
      // 重新附加画布（可选切换渲染器）
      attachCanvas(canvas, renderer) {
          try {
              // 解绑旧画布解锁事件
              const old = this.canvas;
              if (old && old.__unlockHooked && old.__unlockHandler) {
                  try {
                      old.removeEventListener('pointerdown', old.__unlockHandler);
                  }
                  catch { }
                  try {
                      old.removeEventListener('click', old.__unlockHandler);
                  }
                  catch { }
                  old.__unlockHooked = false;
                  old.__unlockHandler = undefined;
              }
          }
          catch { }
          this.canvas = canvas;
          if (renderer)
              this.setRenderer(renderer);
          // 新画布挂载解锁事件
          try {
              const el = this.canvas;
              if (el && !el.__unlockHooked) {
                  const unlock = () => { try {
                      this._ensureAudioUnlocked();
                  }
                  catch { } };
                  el.addEventListener('pointerdown', unlock, { passive: true });
                  el.addEventListener('click', unlock, { passive: true });
                  el.__unlockHooked = true;
                  el.__unlockHandler = unlock;
              }
          }
          catch { }
      }
      // 切换渲染器实现
      setRenderer(kind) {
          try {
              if (kind === 'webgl') {
                  try {
                      // eslint-disable-next-line @typescript-eslint/no-var-requires
                      const ModGL = require('./renderer-webgl');
                      this.renderer2D = new ModGL.RendererWebGL(this.canvas);
                  }
                  catch {
                      // eslint-disable-next-line @typescript-eslint/no-var-requires
                      const Mod2D = require('./renderer-2d');
                      this.renderer2D = new Mod2D.Renderer2D(this.canvas);
                  }
              }
              else {
                  // eslint-disable-next-line @typescript-eslint/no-var-requires
                  const Mod2D = require('./renderer-2d');
                  this.renderer2D = new Mod2D.Renderer2D(this.canvas);
              }
          }
          catch { }
      }
      // 彻底销毁，释放所有资源（包括 worker）
      async destroy() {
          try {
              await this.stop();
          }
          catch { }
          try {
              if (this.worker) {
                  try {
                      this.worker.terminate();
                  }
                  catch { }
                  this.worker = undefined;
              }
          }
          catch { }
          // 解绑画布事件
          try {
              const el = this.canvas;
              if (el && el.__unlockHooked && el.__unlockHandler) {
                  try {
                      el.removeEventListener('pointerdown', el.__unlockHandler);
                  }
                  catch { }
                  try {
                      el.removeEventListener('click', el.__unlockHandler);
                  }
                  catch { }
                  el.__unlockHooked = false;
                  el.__unlockHandler = undefined;
              }
          }
          catch { }
          // 清理统计与监控定时器
          try {
              if (this.statsTimer) {
                  window.clearInterval(this.statsTimer);
                  this.statsTimer = undefined;
              }
          }
          catch { }
          try {
              if (this.stallTimer) {
                  window.clearInterval(this.stallTimer);
                  this.stallTimer = undefined;
              }
          }
          catch { }
          // 页面可见性监听清理（全局一次性挂载，尽量也在销毁时清理）
          try {
              if (window.__pc_vis_hooked && window.__pc_vis_handler) {
                  document.removeEventListener('visibilitychange', window.__pc_vis_handler);
                  window.__pc_vis_hooked = false;
                  window.__pc_vis_handler = undefined;
              }
          }
          catch { }
      }
      _setupWorker() {
          // 防缓存：为 worker.js 附加版本参数，避免浏览器用旧脚本
          try {
              // 每次创建都生成新的随机版本号，防止 HMR/ServiceWorker 复用旧 worker 缓存
              const bust = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
              // 优先使用当前构建输出 dist/index.js；如不可用再回退根目录 worker.js
              const url1 = `dist/index.js?v=${bust}`;
              try {
                  this.worker = new Worker(url1, { type: 'module' });
              }
              catch (e) {
                  const url2 = `worker.js?v=${bust}`;
                  this.worker = new Worker(url2);
              }
          }
          catch {
              // 兜底（极少数环境不允许上面代码时）
              this.worker = new Worker('worker.js');
          }
          this.worker.onmessage = (ev) => this._onWorker(ev.data);
          this.worker.onerror = (ev) => {
              console.error('[PlayerCore] worker error', ev);
              this._restartWorker();
          };
      }
      // worker crash 自动重启，恢复当前 generationId
      _restartWorker() {
          if (this.worker) {
              try {
                  this.worker.terminate();
              }
              catch (e) { }
              this.worker = undefined;
          }
          // 清空状态，避免旧帧/时基污染
          try {
              if (this.videoDecoder) {
                  this.videoDecoder.close();
              }
          }
          catch { }
          try {
              if (this.audioDecoder) {
                  this.audioDecoder.close();
              }
          }
          catch { }
          this.videoDecoder = undefined;
          this.audioDecoder = undefined;
          this.audioConfigured = false;
          this.videoDecodeQueue = [];
          this.audioQueue = [];
          this.audioBasePtsUs = undefined;
          this.audioBaseTime = undefined;
          this.videoReadyForDeltas = false;
          this.pcrBasePtsUs = undefined;
          this.pcrBaseTime = undefined;
          this.softwareVideoActive = false;
          this.softwareAudioActive = false;
          this.lastVideoPtsUs = undefined;
          this.audioScheduledUntilS = 0;
          this._stopAllAudioSources();
          if (this.renderTimer) {
              window.clearInterval(this.renderTimer);
              this.renderTimer = undefined;
          }
          this._setupWorker();
          // 自动恢复会话（仅针对 URL 源；mp4-init 为大缓冲，默认不复用以避免内存占用）
          if (this.lastSource) {
              this.generationId++;
              if (this.lastSource.kind === 'hls' && this.lastSource.url) {
                  const startSeq = (typeof this.lastHlsSeq === 'number') ? Math.max(0, this.lastHlsSeq) : undefined;
                  this.worker?.postMessage({ type: 'openHLS', url: this.lastSource.url, startSeq, generationId: this.generationId });
              }
              else if (this.lastSource.kind === 'flv' && this.lastSource.url) {
                  this.worker?.postMessage({ type: 'openFLV', url: this.lastSource.url, generationId: this.generationId });
              }
              else if (this.lastSource.kind === 'mp4-url' && this.lastSource.url) {
                  this.worker?.postMessage({ type: 'open', url: this.lastSource.url, generationId: this.generationId });
              }
              else if (this.lastSource.kind === 'mp4-init' && this.lastSource.buffer) ;
          }
          if (this.lastWasPlaying) {
              // 重新启动渲染循环，让解码/输出尽快恢复
              if (!this.renderTimer)
                  this.renderTimer = window.setInterval(() => this._renderVideoFrame(), 10);
          }
      }
      _onWorker(msg) {
          // generationId 校验，防止旧消息污染新会话
          if (!msg || typeof msg !== 'object')
              return;
          if ('generationId' in msg && msg.generationId !== this.generationId) {
              // 丢弃旧代际消息
              return;
          }
          // basic dispatch for stage1 & HLS
          switch (msg.type) {
              case 'buffering':
                  this.emit('buffering');
                  break;
              case 'playing':
                  this.emit('playing');
                  break;
              case 'ended':
              case 'eos':
                  // 结束：停止渲染与音频节点
                  try {
                      if (this.renderTimer) {
                          window.clearInterval(this.renderTimer);
                          this.renderTimer = undefined;
                      }
                  }
                  catch { }
                  this._stopAllAudioSources();
                  this.emit('ended');
                  break;
              case 'ready-mp4':
                  // ...existing code...
                  // 启动视频渲染定时器（以音频时钟驱动）
                  if (!this.renderTimer) {
                      this.renderTimer = window.setInterval(() => this._renderVideoFrame(), 10);
                  }
                  try {
                      if (msg.info && typeof msg.info.durationMs === 'number' && msg.info.durationMs > 0)
                          this.mediaDurationMs = msg.info.durationMs;
                  }
                  catch { }
                  // 音频解码器配置（仅当有 audio 信息且支持 WebCodecs）
                  if (msg.info && msg.info.audio && typeof window.AudioDecoder !== 'undefined') {
                      try {
                          this.audioCtx = this.audioCtx || new (window.AudioContext)();
                          const desc = msg.info.audio.description || msg.info.audio.asc || null;
                          // 如果参数变化则重新配置
                          if (this.audioDecoder) {
                              try {
                                  this.audioDecoder.close();
                              }
                              catch (e) { }
                              this.audioDecoder = undefined;
                          }
                          this.audioDecoder = new window.AudioDecoder({
                              output: (frame) => {
                                  try {
                                      this.audioCtx = this.audioCtx || new (window.AudioContext)();
                                      const numberOfChannels = (frame.numberOfChannels) || (frame.format && frame.format.channels) || 2;
                                      const sampleRate = frame.sampleRate || 48000;
                                      const frameCount = frame.numberOfFrames || frame.frameCount || 0;
                                      // 如检测到真实采样率与当前配置不一致，则热重配
                                      try {
                                          if (this.audioConfigured && this.audioConfiguredSampleRate && sampleRate && Math.abs(sampleRate - this.audioConfiguredSampleRate) >= 1) {
                                              const old = this.audioDecoder;
                                              this.audioDecoder = undefined;
                                              this.audioConfigured = false;
                                              try {
                                                  old?.close?.();
                                              }
                                              catch { }
                                              const ad = new window.AudioDecoder({
                                                  output: (f2) => {
                                                      try {
                                                          // 复用现有输出逻辑的简版（避免重复太多）
                                                          const nCh = (f2.numberOfChannels) || 2;
                                                          const sR = f2.sampleRate || sampleRate;
                                                          const fcnt = f2.numberOfFrames || 0;
                                                          let framePtsUs2 = undefined;
                                                          if (typeof f2.timestamp === 'number')
                                                              framePtsUs2 = this.normalizeTsToUs(f2.timestamp);
                                                          this._ensureAudioGraph();
                                                          const abuf = this.audioCtx.createBuffer(nCh, fcnt, sR);
                                                          for (let ch = 0; ch < nCh; ch++) {
                                                              const cd = new Float32Array(fcnt);
                                                              try {
                                                                  f2.copyTo(cd, { planeIndex: ch });
                                                              }
                                                              catch {
                                                                  f2.copyTo(cd);
                                                              }
                                                              abuf.copyToChannel(cd, ch, 0);
                                                          }
                                                          const src2 = this.audioCtx.createBufferSource();
                                                          src2.buffer = abuf;
                                                          src2.connect(this.gainNode);
                                                          this._registerAudioSource(src2);
                                                          try {
                                                              src2.playbackRate.value = this.playbackRate;
                                                          }
                                                          catch { }
                                                          if (this.audioBasePtsUs !== undefined && framePtsUs2 !== undefined && this.audioBaseTime !== undefined) {
                                                              const offsetS = this.US_TO_S(framePtsUs2 - this.audioBasePtsUs);
                                                              const when = Math.max(this.audioCtx.currentTime, this.audioBaseTime + offsetS);
                                                              const now = this.audioCtx.currentTime;
                                                              const durS = (fcnt / sR) / Math.max(0.01, this.playbackRate);
                                                              if (when <= now + 0.02) {
                                                                  src2.start();
                                                                  this.audioScheduledUntilS = Math.max(this.audioScheduledUntilS, now + durS);
                                                              }
                                                              else {
                                                                  try {
                                                                      src2.start(when);
                                                                  }
                                                                  catch {
                                                                      src2.start();
                                                                  }
                                                                  this.audioScheduledUntilS = Math.max(this.audioScheduledUntilS, when + durS);
                                                              }
                                                              try {
                                                                  this._markActivity();
                                                              }
                                                              catch { }
                                                          }
                                                          else {
                                                              src2.start();
                                                          }
                                                      }
                                                      catch { }
                                                      finally {
                                                          try {
                                                              f2.close();
                                                          }
                                                          catch { }
                                                      }
                                                  },
                                                  error: (e) => console.error('AudioDecoder error (reconfig)', e)
                                              });
                                              const nChCfg = this.audioConfiguredChannels || numberOfChannels;
                                              const cfg2 = { codec: this.audioLastCodec || 'mp4a.40.2', numberOfChannels: nChCfg, sampleRate: sampleRate };
                                              if (this.audioLastDescription)
                                                  cfg2.description = this.audioLastDescription;
                                              try {
                                                  const ACtor = window.AudioDecoder;
                                                  if (ACtor.isConfigSupported) {
                                                      ACtor.isConfigSupported(cfg2).then((res) => { try {
                                                          ad.configure(res?.config || cfg2);
                                                      }
                                                      catch {
                                                          ad.configure(cfg2);
                                                      } }).catch(() => { ad.configure(cfg2); });
                                                  }
                                                  else {
                                                      ad.configure(cfg2);
                                                  }
                                              }
                                              catch {
                                                  ad.configure(cfg2);
                                              }
                                              this.audioDecoder = ad;
                                              this.audioConfigured = true;
                                              this.audioConfiguredSampleRate = sampleRate;
                                              this.audioConfiguredChannels = nChCfg;
                                              try {
                                                  if (window.__DEMO_DEBUG)
                                                      console.warn('[audio] hot reconfig to sampleRate=', sampleRate);
                                              }
                                              catch { }
                                          }
                                      }
                                      catch { }
                                      // determine frame timestamp in microseconds
                                      let framePtsUs = undefined;
                                      if (typeof frame.timestamp === 'number') {
                                          framePtsUs = this.normalizeTsToUs(frame.timestamp);
                                      }
                                      // init audio base mapping (zero baseline) if not set and we have a timestamp
                                      if (framePtsUs !== undefined && this.audioBasePtsUs === undefined) {
                                          this.audioBasePtsUs = 0;
                                          this.audioBaseTime = this.audioCtx.currentTime + 0.20; // 更大安全偏移，减少调度抖动
                                          // 一旦音频时基建立，清除 PCR/视频临时时钟，防止误用
                                          this.pcrBasePtsUs = undefined;
                                          this.pcrBaseTime = undefined;
                                          this.videoBasePtsUs = undefined;
                                          this.videoBaseTime = undefined;
                                          try {
                                              if (window.__DEMO_DEBUG)
                                                  console.debug('[clock] audio base set (zero) at', this.audioBaseTime);
                                          }
                                          catch { }
                                      }
                                      const audioBuffer = this.audioCtx.createBuffer(numberOfChannels, frameCount, sampleRate);
                                      for (let ch = 0; ch < numberOfChannels; ch++) {
                                          try {
                                              const channelData = new Float32Array(frameCount);
                                              if (typeof frame.copyTo === 'function') {
                                                  try {
                                                      frame.copyTo(channelData, { planeIndex: ch });
                                                  }
                                                  catch (e) {
                                                      frame.copyTo(channelData);
                                                  }
                                              }
                                              audioBuffer.copyToChannel(channelData, ch, 0);
                                          }
                                          catch (e) {
                                              console.warn('audio channel copy failed', e);
                                          }
                                      }
                                      this._ensureAudioGraph();
                                      const src = this.audioCtx.createBufferSource();
                                      src.buffer = audioBuffer;
                                      src.connect(this.gainNode);
                                      this._registerAudioSource(src);
                                      // scheduling: compute desired start time based on pts mapping
                                      if (framePtsUs !== undefined && (this.audioBaseTime !== undefined || (this.audioBaseTime === undefined && (this.audioBaseTime = this.audioCtx.currentTime + 0.20)))) {
                                          // 统一 0 轴：audioBasePtsUs 固定为 0
                                          this.audioBasePtsUs = 0;
                                          const offsetS = this.US_TO_S(framePtsUs - (this.audioBasePtsUs ?? 0)) / Math.max(0.01, this.playbackRate);
                                          const when = Math.max(this.audioCtx.currentTime, this.audioBaseTime + offsetS);
                                          // if when is in the past, start immediately; else schedule
                                          const now = this.audioCtx.currentTime;
                                          const durS = (frameCount / sampleRate) / Math.max(0.01, this.playbackRate);
                                          if (when <= now + 0.02) {
                                              src.start();
                                              this.audioScheduledUntilS = Math.max(this.audioScheduledUntilS, now + durS);
                                          }
                                          else {
                                              try {
                                                  src.start(when);
                                              }
                                              catch (e) {
                                                  src.start();
                                              }
                                              this.audioScheduledUntilS = Math.max(this.audioScheduledUntilS, when + durS);
                                          }
                                          try {
                                              src.playbackRate.value = this.playbackRate;
                                          }
                                          catch { }
                                          try {
                                              this._markActivity();
                                          }
                                          catch { }
                                      }
                                      else {
                                          // 没有可用的 pts 或其他原因，立即播放并推进已调度窗口
                                          src.start();
                                          try {
                                              const now = this.audioCtx.currentTime;
                                              const durS = (frameCount / sampleRate) / Math.max(0.01, this.playbackRate);
                                              this.audioScheduledUntilS = Math.max(this.audioScheduledUntilS, now + durS);
                                              this._markActivity();
                                          }
                                          catch { }
                                      }
                                  }
                                  catch (e) {
                                      console.warn('AudioDecoder output handling failed', e);
                                  }
                                  finally {
                                      try {
                                          frame.close();
                                      }
                                      catch (e) { }
                                  }
                              },
                              error: (e) => console.error('AudioDecoder error', e)
                          });
                          const codec = msg.info.audio.codec || 'mp4a.40.2';
                          const cfg = { codec };
                          if (desc)
                              cfg.description = desc;
                          // 严格使用 worker 参数（若缺失再退默认）
                          const numCh = (msg.info.audio && (msg.info.audio.numberOfChannels ?? msg.info.audio.channels)) || 2;
                          const sRate = (msg.info.audio && (msg.info.audio.sampleRate ?? msg.info.audio.samplerate)) || 44100;
                          cfg.numberOfChannels = numCh;
                          cfg.sampleRate = sRate;
                          this.audioDecoder.configure(cfg);
                          this.audioConfigured = true;
                          this.audioConfiguredSampleRate = sRate;
                          this.audioConfiguredChannels = numCh;
                          this.audioLastCodec = codec;
                          this.audioLastDescription = desc || null;
                      }
                      catch (e) {
                          console.warn('AudioDecoder configure failed', e);
                      }
                  }
                  // 视频解码器配置（如有 video 信息且支持 WebCodecs）
                  if (msg.info && msg.info.video && typeof window.VideoDecoder !== 'undefined') {
                      try {
                          const desc = msg.info.video.description || msg.info.video.avcC || null;
                          // 从 avcC/description 缓存 SPS/PPS，便于关键帧注入
                          if (desc) {
                              try {
                                  this._cacheSpsPpsFromAvcC(desc);
                              }
                              catch { }
                          }
                          // 如果参数变化则重新配置
                          if (this.videoDecoder) {
                              try {
                                  this.videoDecoder.close();
                              }
                              catch (e) { }
                              this.videoDecoder = undefined;
                          }
                          this.videoReadyForDeltas = false;
                          this.videoDecoder = new window.VideoDecoder({
                              output: (frame) => {
                                  try {
                                      if (window.__DEMO_DEBUG)
                                          console.debug('[vdec] output frame ts(us)=', typeof frame.timestamp === 'number' ? this.normalizeTsToUs(frame.timestamp) : 'n/a');
                                  }
                                  catch { }
                                  // 若尚无音频时钟与视频墙钟，使用首帧视频建立“墙钟回退”
                                  try {
                                      if (this.audioBasePtsUs === undefined && (this.videoBasePtsUs === undefined || this.videoBaseTime === undefined)) {
                                          if (typeof frame.timestamp === 'number') {
                                              const ptsUs = Math.max(0, this.normalizeTsToUs(frame.timestamp));
                                              this.videoBasePtsUs = ptsUs;
                                              this.videoBaseTime = performance.now() / 1000;
                                              try {
                                                  if (window.__DEMO_DEBUG)
                                                      console.debug('[clock] video wall-clock base set us=', ptsUs, ' t0=', this.videoBaseTime);
                                              }
                                              catch { }
                                          }
                                      }
                                  }
                                  catch { }
                                  // 基于音频主钟的呈现调度
                                  const doDraw = () => {
                                      try {
                                          // ensure canvas size matches frame
                                          if (this.canvas && (this.canvas.width !== frame.codedWidth || this.canvas.height !== frame.codedHeight)) {
                                              this.canvas.width = frame.codedWidth;
                                              this.canvas.height = frame.codedHeight;
                                          }
                                          if (this.renderer2D && this.renderer2D.draw) {
                                              try {
                                                  this.renderer2D.draw(frame);
                                              }
                                              catch { }
                                          }
                                          else {
                                              const ctx = (this.canvas && this.canvas.getContext) ? this.canvas.getContext('2d') : null;
                                              if (ctx) {
                                                  try {
                                                      ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
                                                  }
                                                  catch {
                                                      try {
                                                          createImageBitmap(frame).then((bmp) => {
                                                              try {
                                                                  ctx.drawImage(bmp, 0, 0, this.canvas.width, this.canvas.height);
                                                              }
                                                              catch { }
                                                              try {
                                                                  bmp.close();
                                                              }
                                                              catch { }
                                                          }).catch(() => { });
                                                      }
                                                      catch { }
                                                  }
                                              }
                                          }
                                      }
                                      catch (e) { /* ignore draw error */ }
                                      finally {
                                          try {
                                              frame.close();
                                          }
                                          catch { }
                                          this.stats.framesDrawn++;
                                          try {
                                              if (window.__DEMO_DEBUG)
                                                  console.debug('[draw] framesDrawn=', this.stats.framesDrawn);
                                          }
                                          catch { }
                                          try {
                                              this._markActivity();
                                          }
                                          catch { }
                                      }
                                  };
                                  try {
                                      const ptsUs = typeof frame.timestamp === 'number' ? this.normalizeTsToUs(frame.timestamp) : undefined;
                                      if (ptsUs !== undefined && this.lastVideoPtsUs !== undefined && ptsUs < this.lastVideoPtsUs) {
                                          try {
                                              frame.close();
                                          }
                                          catch { }
                                          this.videoReadyForDeltas = true;
                                          return;
                                      }
                                      const drawWithUpdate = () => { doDraw(); if (ptsUs !== undefined)
                                          this.lastVideoPtsUs = ptsUs; };
                                      if (ptsUs !== undefined && this.audioBasePtsUs !== undefined && this.audioBaseTime !== undefined && this.audioCtx) {
                                          const nowS = this.audioCtx.currentTime;
                                          const nowMediaUs = this.audioBasePtsUs + Math.max(0, (nowS - this.audioBaseTime)) * 1e6;
                                          const driftUs = ptsUs - nowMediaUs;
                                          if (driftUs < -this.__dropWindowUs) {
                                              // 严重落后，直接丢弃本帧
                                              try {
                                                  frame.close();
                                              }
                                              catch { }
                                              this.videoReadyForDeltas = true;
                                              return;
                                          }
                                          if (driftUs > this.__leadWindowUs) {
                                              // 严重超前，立即绘制一次，不再等待
                                              drawWithUpdate();
                                          }
                                          else {
                                              const targetS = this.audioBaseTime + this.US_TO_S(ptsUs - this.audioBasePtsUs) / Math.max(0.01, this.playbackRate);
                                              const delayMs = Math.max(0, (targetS - nowS) * 1000);
                                              if (delayMs > 1) {
                                                  setTimeout(drawWithUpdate, Math.min(delayMs, 50));
                                              }
                                              else {
                                                  drawWithUpdate();
                                              }
                                          }
                                      }
                                      else {
                                          drawWithUpdate();
                                      }
                                  }
                                  catch {
                                      doDraw();
                                  }
                                  this.videoReadyForDeltas = true;
                              },
                              error: (e) => {
                                  console.error('VideoDecoder error', e);
                                  try {
                                      this.videoReadyForDeltas = false;
                                      // 丢弃到下一个关键帧，避免错误状态持续
                                      while (this.videoDecodeQueue.length && !this.videoDecodeQueue[0].key) {
                                          this.videoDecodeQueue.shift();
                                          this.stats.framesDropped++;
                                      }
                                  }
                                  catch { }
                              }
                          });
                          const codec = msg.info.video.codec || 'avc1.42E01E';
                          const cfg = { codec, optimizeForLatency: true };
                          try {
                              cfg.hardwareAcceleration = 'prefer-hardware';
                          }
                          catch { }
                          // 若 worker 指明 AnnexB，则不要设置 description（避免与 AnnexB 裸流冲突）
                          const isAnnexB = !!msg.info.video.annexb;
                          if (!isAnnexB && desc) {
                              cfg.description = desc;
                              this.videoDescAttached = true;
                          }
                          else {
                              this.videoDescAttached = false;
                          }
                          this.videoCodec = codec;
                          // 缓存 avcC 中的 SPS/PPS，便于 AnnexB 关键帧注入
                          try {
                              if (desc)
                                  this._cacheSpsPpsFromAvcC(desc);
                          }
                          catch { }
                          try {
                              const Ctor = window.VideoDecoder;
                              if (Ctor.isConfigSupported) {
                                  Ctor.isConfigSupported(cfg).then((res) => {
                                      try {
                                          this.videoDecoder.configure(res?.config || cfg);
                                      }
                                      catch (e) {
                                          this.videoDecoder.configure(cfg);
                                      }
                                  }).catch(() => { this.videoDecoder.configure(cfg); });
                              }
                              else {
                                  this.videoDecoder.configure(cfg);
                              }
                          }
                          catch {
                              this.videoDecoder.configure(cfg);
                          }
                      }
                      catch (e) {
                          console.warn('VideoDecoder configure failed', e);
                          if (this.enableSoftwareFallback) {
                              try {
                                  this.softwareVideoActive = true;
                                  // TODO: 在此处接入 ffmpeg.wasm 解码管线（占位）
                                  console.warn('[fallback] switching to software video decode (stub)');
                              }
                              catch (e2) {
                                  console.warn('software video fallback failed', e2);
                              }
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
                  if (typeof msg.seq === 'number')
                      this.lastHlsSeq = msg.seq;
                  // 可选：根据分片序号维持连续时间轴（需要 msg.segDurationMs）
                  if (this.continuousTimeline && typeof msg.segStartMs === 'number') {
                      this.timelineOffsetUs = Math.max(0, Math.floor(msg.segStartMs * 1000));
                  }
                  break;
              case 'duration':
                  if (typeof msg.ms === 'number' && msg.ms > 0)
                      this.mediaDurationMs = msg.ms;
                  break;
              case 'sample':
                  // 统一时间单位与纪元：若本消息中任一时间字段看起来像 90kHz ticks（非常大），
                  // 则把该消息的所有时间字段按 ticks->microseconds 统一转换，避免 ts/dts/pcr 单位混用。
                  const detectTicks = (v) => (typeof v === 'number' && isFinite(v) && v > 3e9);
                  const msgLooksLikeTicks = detectTicks(msg.ts) || detectTicks(msg.dts) || detectTicks(msg.pcr);
                  const normalizeClock = (v) => {
                      if (v === undefined || !isFinite(v))
                          return undefined;
                      if (msgLooksLikeTicks)
                          return Math.round(v * (1e6 / 90000));
                      const isProbablyTicks = (v > 3e9);
                      return isProbablyTicks ? Math.round(v * (1e6 / 90000)) : Math.round(v);
                  };
                  if (msg.kind === 'video' || msg.kind === 'audio') {
                      const rawTs = normalizeClock(msg.ts);
                      const rawDts = (typeof msg.dts === 'number') ? normalizeClock(msg.dts) : undefined;
                      const rawPcr = (typeof msg.pcr === 'number') ? normalizeClock(msg.pcr) : undefined;
                      // 首次见到任意样本，确定全局 epoch
                      if (this.mediaEpochUs === undefined)
                          this.mediaEpochUs = rawTs;
                      // 所有时间戳减 epoch，落到同一 0 起点轴
                      msg.ts = rawTs - this.mediaEpochUs;
                      if (rawDts !== undefined)
                          msg.dts = rawDts - this.mediaEpochUs;
                      if (rawPcr !== undefined)
                          msg.pcr = rawPcr - this.mediaEpochUs;
                      // 在音频建立前，可选记录 PCR 基点的“墙钟映射”（不影响媒体轴）
                      if (msg.kind === 'video' && this.usePcrBeforeAudio && this.audioBaseTime === undefined && typeof msg.pcr === 'number' && this.pcrBasePtsUs === undefined) {
                          this.pcrBasePtsUs = msg.pcr;
                          this.pcrBaseTime = performance.now() / 1000;
                      }
                  }
                  // 视频 sample 入队（解码顺序队列：DTS 优先），等待音频主钟驱动送入解码器
                  if (msg.kind === 'video') {
                      // 懒配置：若未配置 VideoDecoder，先用稳妥参数配置一个（不带 description）
                      if (!this.videoDecoder && typeof window.VideoDecoder !== 'undefined') {
                          try {
                              const codec = msg.codec || this.videoCodec || 'avc1.42E01E';
                              this.videoCodec = codec;
                              const vout = (frame) => {
                                  const doDraw = () => {
                                      try {
                                          if (this.canvas && (this.canvas.width !== frame.codedWidth || this.canvas.height !== frame.codedHeight)) {
                                              this.canvas.width = frame.codedWidth;
                                              this.canvas.height = frame.codedHeight;
                                          }
                                          if (this.renderer2D && this.renderer2D.draw) {
                                              try {
                                                  this.renderer2D.draw(frame);
                                              }
                                              catch { }
                                          }
                                          else {
                                              const ctx = this.canvas.getContext('2d');
                                              if (ctx) {
                                                  try {
                                                      ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
                                                  }
                                                  catch { }
                                              }
                                          }
                                      }
                                      catch { }
                                      finally {
                                          try {
                                              frame.close();
                                          }
                                          catch { }
                                          this.stats.framesDrawn++;
                                          try {
                                              this._markActivity();
                                          }
                                          catch { }
                                      }
                                  };
                                  try {
                                      const ptsUs = typeof frame.timestamp === 'number' ? this.normalizeTsToUs(frame.timestamp) : undefined;
                                      // 若尚无音频/PCR 时钟，且未建立视频墙钟基准，则用首个输出帧建立基准
                                      if (ptsUs !== undefined && this.audioBasePtsUs === undefined && this.pcrBasePtsUs === undefined && (this.videoBasePtsUs === undefined || this.videoBaseTime === undefined)) {
                                          this.videoBasePtsUs = ptsUs;
                                          this.videoBaseTime = performance.now() / 1000;
                                          try {
                                              if (window.__DEMO_DEBUG)
                                                  console.warn('[clock] video wall-clock base set from first output ts(us)=', ptsUs);
                                          }
                                          catch { }
                                      }
                                      if (ptsUs !== undefined && this.lastVideoPtsUs !== undefined && ptsUs < this.lastVideoPtsUs) {
                                          try {
                                              frame.close();
                                          }
                                          catch { }
                                          this.videoReadyForDeltas = true;
                                          return;
                                      }
                                      const drawWithUpdate = () => { doDraw(); if (ptsUs !== undefined)
                                          this.lastVideoPtsUs = ptsUs; };
                                      if (ptsUs !== undefined && this.audioBasePtsUs !== undefined && this.audioBaseTime !== undefined && this.audioCtx) {
                                          const nowS = this.audioCtx.currentTime;
                                          const nowMediaUs = this.audioBasePtsUs + Math.max(0, (nowS - this.audioBaseTime)) * 1e6;
                                          const driftUs = ptsUs - nowMediaUs;
                                          if (driftUs < -this.__dropWindowUs) {
                                              try {
                                                  frame.close();
                                              }
                                              catch { }
                                              this.videoReadyForDeltas = true;
                                              return;
                                          }
                                          if (driftUs > this.__leadWindowUs) {
                                              drawWithUpdate();
                                          }
                                          else {
                                              const targetS = this.audioBaseTime + this.US_TO_S(ptsUs - this.audioBasePtsUs) / Math.max(0.01, this.playbackRate);
                                              const delayMs = Math.max(0, (targetS - nowS) * 1000);
                                              if (delayMs > 1)
                                                  setTimeout(drawWithUpdate, Math.min(delayMs, 50));
                                              else
                                                  drawWithUpdate();
                                          }
                                      }
                                      else {
                                          drawWithUpdate();
                                      }
                                  }
                                  catch {
                                      doDraw();
                                  }
                                  this.videoReadyForDeltas = true;
                              };
                              const verr = (e) => { console.error('VideoDecoder error (lazy)', e); };
                              const dec = new window.VideoDecoder({ output: vout, error: verr });
                              const cfg = { codec, optimizeForLatency: true };
                              try {
                                  cfg.hardwareAcceleration = 'prefer-hardware';
                              }
                              catch { }
                              const VCtor = window.VideoDecoder;
                              if (VCtor.isConfigSupported) {
                                  VCtor.isConfigSupported(cfg)
                                      .then((r) => { try {
                                      dec.configure(r?.config || cfg);
                                  }
                                  catch {
                                      dec.configure(cfg);
                                  } })
                                      .catch(() => { try {
                                      dec.configure(cfg);
                                  }
                                  catch { } });
                              }
                              else {
                                  try {
                                      dec.configure(cfg);
                                  }
                                  catch { }
                              }
                              this.videoDecoder = dec;
                              this.videoDescAttached = false;
                              this.videoReadyForDeltas = false;
                              try {
                                  if (window.__DEMO_DEBUG)
                                      console.warn('[video] lazy configured:', codec);
                              }
                              catch { }
                          }
                          catch (e) {
                              console.warn('video lazy-config failed', e);
                          }
                      }
                      try {
                          if (window.__DEMO_DEBUG)
                              console.debug('[queue] video sample enq, ts(us)=', this.normalizeTsToUs(msg.ts));
                      }
                      catch { }
                      // ts/dts 已经按 epoch 对齐为微秒；无需再次转换
                      // 第一次看到视频样本时检测实际格式；如是 AnnexB 且当前配置附带 description，则去掉 description 热重配
                      if (!this.firstVideoSeen) {
                          this.firstVideoSeen = true;
                          try {
                              this.annexbDetected = this._isAnnexB(msg.data);
                              if (this.annexbDetected && this.videoDescAttached && typeof window.VideoDecoder !== 'undefined') {
                                  try {
                                      const old = this.videoDecoder;
                                      this.videoDecoder = undefined;
                                      try {
                                          old?.close?.();
                                      }
                                      catch { }
                                      const vdec = new window.VideoDecoder({
                                          output: (frame) => {
                                              try {
                                                  if (window.__DEMO_DEBUG)
                                                      console.debug('[vdec] output frame ts(us)=', typeof frame.timestamp === 'number' ? this.normalizeTsToUs(frame.timestamp) : 'n/a');
                                              }
                                              catch { }
                                              // 与 ready-mp4 路径一致的绘制逻辑
                                              const doDraw = () => {
                                                  try {
                                                      if (this.canvas && (this.canvas.width !== frame.codedWidth || this.canvas.height !== frame.codedHeight)) {
                                                          this.canvas.width = frame.codedWidth;
                                                          this.canvas.height = frame.codedHeight;
                                                      }
                                                      if (this.renderer2D && this.renderer2D.draw) {
                                                          try {
                                                              this.renderer2D.draw(frame);
                                                          }
                                                          catch { }
                                                      }
                                                      else {
                                                          const ctx = (this.canvas && this.canvas.getContext) ? this.canvas.getContext('2d') : null;
                                                          if (ctx) {
                                                              try {
                                                                  ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
                                                              }
                                                              catch { }
                                                          }
                                                      }
                                                  }
                                                  catch { }
                                                  finally {
                                                      try {
                                                          frame.close();
                                                      }
                                                      catch { }
                                                      this.stats.framesDrawn++;
                                                      try {
                                                          this._markActivity();
                                                      }
                                                      catch { }
                                                  }
                                              };
                                              try {
                                                  const ptsUs = typeof frame.timestamp === 'number' ? this.normalizeTsToUs(frame.timestamp) : undefined;
                                                  if (ptsUs !== undefined && this.lastVideoPtsUs !== undefined && ptsUs < this.lastVideoPtsUs) {
                                                      try {
                                                          frame.close();
                                                      }
                                                      catch { }
                                                      this.videoReadyForDeltas = true;
                                                      return;
                                                  }
                                                  const drawWithUpdate = () => { doDraw(); if (ptsUs !== undefined)
                                                      this.lastVideoPtsUs = ptsUs; };
                                                  if (ptsUs !== undefined && this.audioBasePtsUs !== undefined && this.audioBaseTime !== undefined && this.audioCtx) {
                                                      const targetS = this.audioBaseTime + this.US_TO_S(ptsUs - this.audioBasePtsUs) / Math.max(0.01, this.playbackRate);
                                                      const nowS = this.audioCtx.currentTime;
                                                      const delayMs = Math.max(0, (targetS - nowS) * 1000);
                                                      if (delayMs > 1)
                                                          setTimeout(drawWithUpdate, Math.min(delayMs, 50));
                                                      else
                                                          drawWithUpdate();
                                                  }
                                                  else {
                                                      drawWithUpdate();
                                                  }
                                              }
                                              catch {
                                                  doDraw();
                                              }
                                              this.videoReadyForDeltas = true;
                                          },
                                          error: (e) => { console.error('VideoDecoder error (reconfig)', e); }
                                      });
                                      const cfg2 = { codec: this.videoCodec || 'avc1.42E01E', optimizeForLatency: true };
                                      try {
                                          cfg2.hardwareAcceleration = 'prefer-hardware';
                                      }
                                      catch { }
                                      const VCtor = window.VideoDecoder;
                                      if (VCtor && VCtor.isConfigSupported) {
                                          VCtor.isConfigSupported(cfg2)
                                              .then((res) => { try {
                                              vdec.configure(res?.config || cfg2);
                                          }
                                          catch {
                                              vdec.configure(cfg2);
                                          } })
                                              .catch(() => { vdec.configure(cfg2); });
                                      }
                                      else {
                                          vdec.configure(cfg2);
                                      }
                                      this.videoDecoder = vdec;
                                      this.videoDescAttached = false;
                                      this.videoReadyForDeltas = false;
                                      if (window.__DEMO_DEBUG) {
                                          try {
                                              console.warn('[video] hot reconfig: remove description for AnnexB');
                                          }
                                          catch { }
                                      }
                                  }
                                  catch (e) {
                                      console.warn('video hot-reconfig failed', e);
                                  }
                              }
                          }
                          catch { }
                      }
                      // 若既无音频也无 PCR，也还没视频墙钟，用首个视频样本先建立 provisional 墙钟
                      if (this.audioBaseTime === undefined && this.pcrBaseTime === undefined && (this.videoBaseTime === undefined || this.videoBasePtsUs === undefined) && typeof msg.ts === 'number' && isFinite(msg.ts)) {
                          this.videoBasePtsUs = msg.ts;
                          this.videoBaseTime = performance.now() / 1000;
                          try {
                              if (window.__DEMO_DEBUG)
                                  console.warn('[clock] provisional video wall-clock set from first sample ts(us)=', this.videoBasePtsUs, ' t0=', this.videoBaseTime);
                          }
                          catch { }
                      }
                      // 进一步防御：夹紧异常 dts 到 pts 附近
                      let safeDts = undefined;
                      try {
                          if (typeof msg.dts === 'number') {
                              const d = Number(msg.dts) || 0;
                              const p = Number(msg.ts) || 0;
                              if (isFinite(d)) {
                                  const diff = d - p;
                                  safeDts = (Math.abs(diff) > 5000000 || d < 0) ? p : d;
                              }
                          }
                      }
                      catch { }
                      try {
                          if (window.__DEMO_DEBUG) {
                              console.debug('[enq]', { kind: 'video', ts: msg.ts, dts: safeDts ?? msg.dts, pcr: msg.pcr, baseV: this.videoBasePtsUs, baseA: this.audioBasePtsUs });
                          }
                      }
                      catch { }
                      this.videoDecodeQueue.push({ ts: msg.ts, dts: safeDts, key: !!msg.key, data: msg.data, dur: typeof msg.dur === 'number' ? this.normalizeTsToUs(msg.dur) : undefined });
                      if (this.videoDecodeQueue.length > 1) {
                          const pick = (s) => (s.dts ?? s.ts);
                          this.videoDecodeQueue.sort((a, b) => pick(a) - pick(b));
                      }
                      // 高水位背压：超过上限时丢弃最旧的若干帧（按 DTS 排序的队头）
                      if (this.videoDecodeQueue.length > this.__maxVideoQueue) {
                          const overflow = this.videoDecodeQueue.length - this.__maxVideoQueue;
                          this.videoDecodeQueue.splice(0, overflow);
                      }
                      // 立刻尝试推进一次渲染，并确保渲染循环已启动
                      try {
                          this._renderVideoFrame();
                      }
                      catch { }
                      try {
                          if (!this.renderTimer)
                              this.renderTimer = window.setInterval(() => this._renderVideoFrame(), 10);
                      }
                      catch { }
                  }
                  // 音频 sample 直接解码
                  // 懒配置：若未配置 AudioDecoder，先按稳妥参数配置
                  if (msg.kind === 'audio' && !this.audioDecoder && typeof window.AudioDecoder !== 'undefined') {
                      try {
                          const codec = msg.codec || this.audioLastCodec || 'mp4a.40.2';
                          const numCh = msg.channels || 2;
                          const sRate = msg.sampleRate || 44100;
                          this.audioCtx = this.audioCtx || new (window.AudioContext)();
                          const ad = new window.AudioDecoder({
                              output: (frame) => {
                                  try {
                                      try {
                                          if (this.audioCtx && String(this.audioCtx.state) === 'suspended')
                                              this.audioCtx.resume();
                                      }
                                      catch { }
                                      const numberOfChannels = frame.numberOfChannels || numCh;
                                      const sampleRate = frame.sampleRate || sRate;
                                      const frameCount = frame.numberOfFrames || frame.frameCount || 0;
                                      let framePtsUs = undefined;
                                      if (typeof frame.timestamp === 'number')
                                          framePtsUs = this.normalizeTsToUs(frame.timestamp);
                                      if (framePtsUs !== undefined && this.audioBasePtsUs === undefined) {
                                          this.audioBasePtsUs = 0;
                                          this.audioBaseTime = this.audioCtx.currentTime + 0.20;
                                          this.pcrBasePtsUs = undefined;
                                          this.pcrBaseTime = undefined;
                                          this.videoBasePtsUs = undefined;
                                          this.videoBaseTime = undefined;
                                      }
                                      this._ensureAudioGraph();
                                      const audioBuffer = this.audioCtx.createBuffer(numberOfChannels, frameCount, sampleRate);
                                      for (let ch = 0; ch < numberOfChannels; ch++) {
                                          const channelData = new Float32Array(frameCount);
                                          try {
                                              frame.copyTo(channelData, { planeIndex: ch });
                                          }
                                          catch {
                                              frame.copyTo(channelData);
                                          }
                                          audioBuffer.copyToChannel(channelData, ch, 0);
                                      }
                                      const src = this.audioCtx.createBufferSource();
                                      src.buffer = audioBuffer;
                                      src.connect(this.gainNode);
                                      this._registerAudioSource(src);
                                      if (this.audioBasePtsUs !== undefined && framePtsUs !== undefined && this.audioBaseTime !== undefined) {
                                          const offsetS = this.US_TO_S(framePtsUs - (this.audioBasePtsUs ?? 0)) / Math.max(0.01, this.playbackRate);
                                          const when = Math.max(this.audioCtx.currentTime, this.audioBaseTime + offsetS);
                                          const now = this.audioCtx.currentTime;
                                          const durS = (frameCount / sampleRate) / Math.max(0.01, this.playbackRate);
                                          if (when <= now + 0.02) {
                                              src.start();
                                              this.audioScheduledUntilS = Math.max(this.audioScheduledUntilS, now + durS);
                                          }
                                          else {
                                              try {
                                                  src.start(when);
                                              }
                                              catch {
                                                  src.start();
                                              }
                                              this.audioScheduledUntilS = Math.max(this.audioScheduledUntilS, when + durS);
                                          }
                                          try {
                                              src.playbackRate.value = this.playbackRate;
                                          }
                                          catch { }
                                          try {
                                              this._markActivity();
                                          }
                                          catch { }
                                      }
                                      else {
                                          src.start();
                                      }
                                  }
                                  catch (e) {
                                      console.warn('AudioDecoder output handling failed (lazy)', e);
                                  }
                                  finally {
                                      try {
                                          frame.close();
                                      }
                                      catch { }
                                  }
                              },
                              error: (e) => console.error('AudioDecoder error (lazy)', e)
                          });
                          const cfg = { codec, numberOfChannels: numCh, sampleRate: sRate };
                          const ACtor = window.AudioDecoder;
                          if (ACtor.isConfigSupported) {
                              ACtor.isConfigSupported(cfg)
                                  .then((r) => { try {
                                  ad.configure(r?.config || cfg);
                              }
                              catch {
                                  ad.configure(cfg);
                              } })
                                  .catch(() => { try {
                                  ad.configure(cfg);
                              }
                              catch { } });
                          }
                          else {
                              try {
                                  ad.configure(cfg);
                              }
                              catch { }
                          }
                          this.audioDecoder = ad;
                          this.audioConfigured = true;
                          this.audioConfiguredChannels = numCh;
                          this.audioConfiguredSampleRate = sRate;
                          this.audioLastCodec = codec;
                          this.audioLastDescription = null;
                          try {
                              if (window.__DEMO_DEBUG)
                                  console.warn('[audio] lazy configured:', codec, numCh, sRate);
                          }
                          catch { }
                      }
                      catch (e) {
                          console.warn('audio lazy-config failed', e);
                      }
                  }
                  if (msg.kind === 'audio' && this.audioDecoder && this.audioConfigured) {
                      try {
                          // 跳过空音频帧，避免解码错误并阻塞音频时钟建立
                          const dataLen = (msg.data && msg.data.byteLength) ? msg.data.byteLength : 0;
                          // 新增：空音频帧也可用于建立音频时基（只建立时钟，不解码音频数据）
                          if (dataLen <= 0) {
                              try {
                                  if (typeof msg.ts === 'number') {
                                      this.audioCtx = this.audioCtx || new (window.AudioContext)();
                                      if (this.audioBasePtsUs === undefined) {
                                          this.audioBasePtsUs = 0;
                                          this.audioBaseTime = this.audioCtx.currentTime + 0.20;
                                          this.pcrBasePtsUs = undefined;
                                          this.pcrBaseTime = undefined;
                                          this.videoBasePtsUs = undefined;
                                          this.videoBaseTime = undefined;
                                          try {
                                              if (window.__DEMO_DEBUG)
                                                  console.debug('[clock] audio base set (from empty frame ts) at', this.audioBaseTime);
                                          }
                                          catch { }
                                      }
                                  }
                              }
                              catch { }
                              break;
                          }
                          // normalize & clamp ts
                          msg.ts = this.normalizeTsToUs(msg.ts);
                          const tsSafe = Math.max(0, Number(msg.ts) || 0);
                          const ainit = { type: 'key', timestamp: tsSafe, data: msg.data };
                          if (typeof msg.dur === 'number' && msg.dur > 0)
                              ainit.duration = this.normalizeTsToUs(msg.dur);
                          const chunk = new window.EncodedAudioChunk(ainit);
                          this.audioDecoder.decode(chunk);
                          // 若发现真实输出采样率与配置不一致，则热重配
                      }
                      catch (e) {
                          console.warn('audio decode failed', e);
                      }
                  }
                  break;
              case 'stream-info':
                  // worker 显式声明流属性（例如无音频），则关闭音频时钟，启用视频/PCR 回退
                  try {
                      if (msg.hasAudio === false) {
                          try {
                              if (this.audioDecoder) {
                                  this.audioDecoder.close();
                              }
                          }
                          catch { }
                          this.audioDecoder = undefined;
                          this.audioConfigured = false;
                          this.audioBasePtsUs = undefined;
                          this.audioBaseTime = undefined;
                      }
                  }
                  catch { }
                  break;
              case 'discontinuity':
                  // 分片/轨道发生 DISCONTINUITY：重置时基与队列，按新段首帧重建零点
                  try {
                      try {
                          (this.videoDecoder?.flush?.() || Promise.resolve()).catch(() => { });
                      }
                      catch { }
                      try {
                          (this.audioDecoder?.flush?.() || Promise.resolve()).catch(() => { });
                      }
                      catch { }
                      this.videoDecodeQueue = [];
                      this.audioQueue = [];
                      this.videoReadyForDeltas = false;
                      this.audioBasePtsUs = undefined;
                      this.audioBaseTime = undefined;
                      this.videoBasePtsUs = undefined;
                      this.videoBaseTime = undefined;
                      this.pcrBasePtsUs = undefined;
                      this.pcrBaseTime = undefined;
                      this.mediaEpochUs = undefined;
                      this.firstVideoSeen = false;
                      this.annexbDetected = false;
                      this.lastVideoPtsUs = undefined;
                      // 保持 UI 连续：累加时间轴偏移
                      if (this.continuousTimeline && typeof msg.nextStartUs === 'number') {
                          this.timelineOffsetUs = Math.max(this.timelineOffsetUs, Math.floor(msg.nextStartUs));
                      }
                      this._stopAllAudioSources();
                      if (window.__DEMO_DEBUG) {
                          try {
                              console.warn('[clock] discontinuity: reset bases and queues');
                          }
                          catch { }
                      }
                  }
                  catch { }
                  break;
              case 'config-update':
                  // 运行时 extradata 变化（SPS/PPS/ASC），执行解码器重配置
                  if (msg.video && typeof window.VideoDecoder !== 'undefined') {
                      try {
                          if (this.videoDecoder) {
                              try {
                                  this.videoDecoder.close();
                              }
                              catch (e) { }
                          }
                          this.videoReadyForDeltas = false;
                          this.videoDecoder = new window.VideoDecoder({
                              output: (frame) => {
                                  const doDraw = () => {
                                      try {
                                          if (this.canvas && (this.canvas.width !== frame.codedWidth || this.canvas.height !== frame.codedHeight)) {
                                              this.canvas.width = frame.codedWidth;
                                              this.canvas.height = frame.codedHeight;
                                          }
                                          if (this.renderer2D && this.renderer2D.draw) {
                                              try {
                                                  this.renderer2D.draw(frame);
                                              }
                                              catch { }
                                          }
                                          else {
                                              const ctx = this.canvas.getContext('2d');
                                              if (ctx) {
                                                  try {
                                                      ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
                                                  }
                                                  catch { }
                                              }
                                          }
                                      }
                                      catch { }
                                      finally {
                                          try {
                                              frame.close();
                                          }
                                          catch { }
                                          this.stats.framesDrawn++;
                                          try {
                                              this._markActivity();
                                          }
                                          catch { }
                                      }
                                  };
                                  try {
                                      const ptsUs = typeof frame.timestamp === 'number' ? this.normalizeTsToUs(frame.timestamp) : undefined;
                                      // 若尚无音频/PCR 时钟，且未建立视频墙钟基准，则用首个输出帧建立基准
                                      if (ptsUs !== undefined && this.audioBasePtsUs === undefined && this.pcrBasePtsUs === undefined && (this.videoBasePtsUs === undefined || this.videoBaseTime === undefined)) {
                                          this.videoBasePtsUs = ptsUs;
                                          this.videoBaseTime = performance.now() / 1000;
                                          try {
                                              if (window.__DEMO_DEBUG)
                                                  console.warn('[clock] video wall-clock base set from output ts(us)=', ptsUs);
                                          }
                                          catch { }
                                      }
                                      if (ptsUs !== undefined && this.lastVideoPtsUs !== undefined && ptsUs < this.lastVideoPtsUs) {
                                          try {
                                              frame.close();
                                          }
                                          catch { }
                                          this.videoReadyForDeltas = true;
                                          return;
                                      }
                                      const drawWithUpdate = () => { doDraw(); if (ptsUs !== undefined)
                                          this.lastVideoPtsUs = ptsUs; };
                                      if (ptsUs !== undefined && this.audioBasePtsUs !== undefined && this.audioBaseTime !== undefined && this.audioCtx) {
                                          const targetS = this.audioBaseTime + this.US_TO_S(ptsUs - this.audioBasePtsUs) / Math.max(0.01, this.playbackRate);
                                          const nowS = this.audioCtx.currentTime;
                                          const delayMs = Math.max(0, (targetS - nowS) * 1000);
                                          if (delayMs > 1)
                                              setTimeout(drawWithUpdate, Math.min(delayMs, 50));
                                          else
                                              drawWithUpdate();
                                      }
                                      else {
                                          drawWithUpdate();
                                      }
                                  }
                                  catch {
                                      doDraw();
                                  }
                                  this.videoReadyForDeltas = true;
                              },
                              error: (e) => {
                                  console.error('VideoDecoder error', e);
                                  try {
                                      this.videoReadyForDeltas = false;
                                      while (this.videoDecodeQueue.length && !this.videoDecodeQueue[0].key) {
                                          this.videoDecodeQueue.shift();
                                          this.stats.framesDropped++;
                                      }
                                  }
                                  catch { }
                              }
                          });
                          const cfg = { codec: msg.video.codec || 'avc1.42E01E', optimizeForLatency: true };
                          try {
                              cfg.hardwareAcceleration = 'prefer-hardware';
                          }
                          catch { }
                          // 若标记为 AnnexB，忽略 description，避免与 AnnexB 裸流冲突
                          const isAnnexB = !!msg.video.annexb;
                          if (!isAnnexB && msg.video.description)
                              cfg.description = msg.video.description;
                          // 同步缓存新的参数集（若提供了 avcC/description）
                          try {
                              if (msg.video.description)
                                  this._cacheSpsPpsFromAvcC(msg.video.description);
                          }
                          catch { }
                          try {
                              if (window.__DEMO_DEBUG)
                                  console.debug('[vcfg] reconfig video annexb=', isAnnexB, 'codec=', cfg.codec, 'desc?', !!cfg.description);
                          }
                          catch { }
                          try {
                              const Ctor = window.VideoDecoder;
                              if (Ctor.isConfigSupported) {
                                  Ctor.isConfigSupported(cfg).then((res) => {
                                      try {
                                          this.videoDecoder.configure(res?.config || cfg);
                                      }
                                      catch (e) {
                                          this.videoDecoder.configure(cfg);
                                      }
                                  }).catch(() => { this.videoDecoder.configure(cfg); });
                              }
                              else {
                                  this.videoDecoder.configure(cfg);
                              }
                          }
                          catch {
                              this.videoDecoder.configure(cfg);
                          }
                      }
                      catch (e) {
                          console.warn('Video reconfigure failed', e);
                          if (this.enableSoftwareFallback) {
                              try {
                                  this.softwareVideoActive = true;
                                  console.warn('[fallback] switching to software video decode (stub)');
                              }
                              catch { }
                          }
                      }
                  }
                  if (msg.audio && typeof window.AudioDecoder !== 'undefined') {
                      try {
                          this.audioConfigured = false;
                          if (this.audioDecoder) {
                              try {
                                  this.audioDecoder.close();
                              }
                              catch (e) { }
                          }
                          // 复用 ready-mp4 中的 output 逻辑（简化：仅重建配置）
                          const ad = new window.AudioDecoder({ output: (frame) => {
                                  try {
                                      this.audioCtx = this.audioCtx || new (window.AudioContext)();
                                      const numberOfChannels = (frame.numberOfChannels) || (frame.format && frame.format.channels) || 2;
                                      const sampleRate = frame.sampleRate || 48000;
                                      const frameCount = frame.numberOfFrames || frame.frameCount || 0;
                                      // 如检测到真实采样率与当前配置不一致，则热重配
                                      try {
                                          if (this.audioConfigured && this.audioConfiguredSampleRate && sampleRate && Math.abs(sampleRate - this.audioConfiguredSampleRate) >= 1) {
                                              const old = this.audioDecoder;
                                              this.audioDecoder = undefined;
                                              this.audioConfigured = false;
                                              try {
                                                  old?.close?.();
                                              }
                                              catch { }
                                              const ad2 = new window.AudioDecoder({
                                                  output: (f2) => {
                                                      try {
                                                          const nCh = (f2.numberOfChannels) || 2;
                                                          const sR = f2.sampleRate || sampleRate;
                                                          const fcnt = f2.numberOfFrames || 0;
                                                          let framePtsUs2 = undefined;
                                                          if (typeof f2.timestamp === 'number')
                                                              framePtsUs2 = this.normalizeTsToUs(f2.timestamp);
                                                          this._ensureAudioGraph();
                                                          const abuf = this.audioCtx.createBuffer(nCh, fcnt, sR);
                                                          for (let ch = 0; ch < nCh; ch++) {
                                                              const cd = new Float32Array(fcnt);
                                                              try {
                                                                  f2.copyTo(cd, { planeIndex: ch });
                                                              }
                                                              catch {
                                                                  f2.copyTo(cd);
                                                              }
                                                              abuf.copyToChannel(cd, ch, 0);
                                                          }
                                                          const src2 = this.audioCtx.createBufferSource();
                                                          src2.buffer = abuf;
                                                          src2.connect(this.gainNode);
                                                          this._registerAudioSource(src2);
                                                          if (framePtsUs2 !== undefined) {
                                                              if (this.audioBaseTime === undefined) {
                                                                  this.audioBaseTime = this.audioCtx.currentTime + 0.20;
                                                                  this.audioBasePtsUs = 0;
                                                              }
                                                              const baseUs2 = this.audioBasePtsUs ?? 0;
                                                              const offsetS = this.US_TO_S(framePtsUs2 - baseUs2) / Math.max(0.01, this.playbackRate);
                                                              const when = Math.max(this.audioCtx.currentTime, this.audioBaseTime + offsetS);
                                                              const now = this.audioCtx.currentTime;
                                                              if (when <= now + 0.02)
                                                                  src2.start();
                                                              else
                                                                  try {
                                                                      src2.start(when);
                                                                  }
                                                                  catch {
                                                                      src2.start();
                                                                  }
                                                          }
                                                          else {
                                                              src2.start();
                                                          }
                                                      }
                                                      catch { }
                                                      finally {
                                                          try {
                                                              f2.close();
                                                          }
                                                          catch { }
                                                      }
                                                  },
                                                  error: (e) => console.error('AudioDecoder error (reconfig)', e)
                                              });
                                              const nChCfg = this.audioConfiguredChannels || numberOfChannels;
                                              const cfg2 = { codec: this.audioLastCodec || 'mp4a.40.2', numberOfChannels: nChCfg, sampleRate: sampleRate };
                                              if (this.audioLastDescription)
                                                  cfg2.description = this.audioLastDescription;
                                              try {
                                                  const ACtor = window.AudioDecoder;
                                                  if (ACtor.isConfigSupported) {
                                                      ACtor.isConfigSupported(cfg2).then((res) => { try {
                                                          ad2.configure(res?.config || cfg2);
                                                      }
                                                      catch {
                                                          ad2.configure(cfg2);
                                                      } }).catch(() => { ad2.configure(cfg2); });
                                                  }
                                                  else {
                                                      ad2.configure(cfg2);
                                                  }
                                              }
                                              catch {
                                                  ad2.configure(cfg2);
                                              }
                                              this.audioDecoder = ad2;
                                              this.audioConfigured = true;
                                              this.audioConfiguredSampleRate = sampleRate;
                                              this.audioConfiguredChannels = nChCfg;
                                              try {
                                                  if (window.__DEMO_DEBUG)
                                                      console.warn('[audio] hot reconfig to sampleRate=', sampleRate);
                                              }
                                              catch { }
                                          }
                                      }
                                      catch { }
                                      let framePtsUs = undefined;
                                      if (typeof frame.timestamp === 'number')
                                          framePtsUs = this.normalizeTsToUs(frame.timestamp);
                                      if (framePtsUs !== undefined && this.audioBasePtsUs === undefined) {
                                          this.audioBasePtsUs = 0;
                                          this.audioBaseTime = this.audioCtx.currentTime + 0.20;
                                          this.pcrBasePtsUs = undefined;
                                          this.pcrBaseTime = undefined;
                                          this.videoBasePtsUs = undefined;
                                          this.videoBaseTime = undefined;
                                          try {
                                              if (window.__DEMO_DEBUG)
                                                  console.debug('[clock] audio base set (zero) at', this.audioBaseTime);
                                          }
                                          catch { }
                                      }
                                      const audioBuffer = this.audioCtx.createBuffer(numberOfChannels, frameCount, sampleRate);
                                      for (let ch = 0; ch < numberOfChannels; ch++) {
                                          const channelData = new Float32Array(frameCount);
                                          try {
                                              frame.copyTo(channelData, { planeIndex: ch });
                                          }
                                          catch {
                                              frame.copyTo(channelData);
                                          }
                                          audioBuffer.copyToChannel(channelData, ch, 0);
                                      }
                                      this._ensureAudioGraph();
                                      const src = this.audioCtx.createBufferSource();
                                      src.buffer = audioBuffer;
                                      src.connect(this.gainNode);
                                      this._registerAudioSource(src);
                                      if (this.audioBasePtsUs !== undefined && framePtsUs !== undefined && this.audioBaseTime !== undefined) {
                                          const offsetS = this.US_TO_S(framePtsUs - (this.audioBasePtsUs ?? 0)) / Math.max(0.01, this.playbackRate);
                                          const when = Math.max(this.audioCtx.currentTime, this.audioBaseTime + offsetS);
                                          const now = this.audioCtx.currentTime;
                                          const durS = (frameCount / sampleRate) / Math.max(0.01, this.playbackRate);
                                          if (when <= now + 0.02) {
                                              src.start();
                                              this.audioScheduledUntilS = Math.max(this.audioScheduledUntilS, now + durS);
                                          }
                                          else {
                                              try {
                                                  src.start(when);
                                              }
                                              catch {
                                                  src.start();
                                              }
                                              this.audioScheduledUntilS = Math.max(this.audioScheduledUntilS, when + durS);
                                          }
                                          try {
                                              src.playbackRate.value = this.playbackRate;
                                          }
                                          catch { }
                                          try {
                                              this._markActivity();
                                          }
                                          catch { }
                                      }
                                      else {
                                          src.start();
                                          if (framePtsUs !== undefined && this.audioBasePtsUs === undefined) {
                                              this.audioBasePtsUs = 0;
                                              this.audioBaseTime = this.audioCtx.currentTime;
                                              this.pcrBasePtsUs = undefined;
                                              this.pcrBaseTime = undefined;
                                              this.videoBasePtsUs = undefined;
                                              this.videoBaseTime = undefined;
                                              try {
                                                  if (window.__DEMO_DEBUG)
                                                      console.debug('[clock] audio base set (zero) at', this.audioBaseTime);
                                              }
                                              catch { }
                                          }
                                      }
                                  }
                                  catch (e) {
                                      console.warn('AudioDecoder output handling failed', e);
                                  }
                                  finally {
                                      try {
                                          frame.close();
                                      }
                                      catch { }
                                  }
                              }, error: (e) => { console.error('AudioDecoder error', e); try {
                                  this.emit('error', e);
                              }
                              catch { } } });
                          const cfg = { codec: msg.audio.codec || 'mp4a.40.2' };
                          if (msg.audio.description)
                              cfg.description = msg.audio.description;
                          // numberOfChannels and sampleRate are required for AudioDecoder configuration
                          cfg.numberOfChannels = msg.audio.numberOfChannels ?? 2;
                          cfg.sampleRate = msg.audio.sampleRate ?? 48000;
                          try {
                              const ACtor = window.AudioDecoder;
                              if (ACtor.isConfigSupported) {
                                  ACtor.isConfigSupported(cfg).then((res) => {
                                      try {
                                          ad.configure(res?.config || cfg);
                                      }
                                      catch (e) {
                                          ad.configure(cfg);
                                      }
                                  }).catch(() => { ad.configure(cfg); });
                              }
                              else {
                                  ad.configure(cfg);
                              }
                          }
                          catch {
                              ad.configure(cfg);
                          }
                          this.audioDecoder = ad;
                          this.audioConfigured = true;
                      }
                      catch (e) {
                          console.warn('Audio reconfigure failed', e);
                      }
                  }
                  break;
              case 'log':
                  try {
                      const msgStr = String(msg.msg ?? '');
                      // 控制台输出
                      // 使用 console.debug 降低噪音；可通过 window.__DEMO_DEBUG 控制
                      if (window.__DEMO_DEBUG)
                          console.info('[worker]', msgStr);
                      else
                          console.debug('[worker]', msgStr);
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
                      }
                      catch { }
                  }
                  catch { }
                  break;
              // ...existing code...
          }
      }
  }

  // expose to window for demo page
  window.PlayerCore = PlayerCore;
  try {
      if (window.__DEMO_DEBUG)
          console.info('demo entry: PlayerCore exposed to window');
  }
  catch { }

  return PlayerCore;

})();
//# sourceMappingURL=demo.js.map
