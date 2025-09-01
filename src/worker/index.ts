// 内部 HLS/MP4 任务状态
let hlsAbort = false;
let currentMode: 'hls' | 'mp4' | null = null;
let pendingHlsSeekMs: number | null = null; // 仅对 VOD 生效
// 当主线程请求尽快定位下一关键帧时设置该标志
let pendingKeyRequest: boolean = false;
type Mp4Session = { mp4box: any, vTrack?: any, aTrack?: any } | null;
let mp4Session: Mp4Session = null;
// Global HLS variant state for external control
let gHlsVariants: string[] | null = null;
let gHlsVariantIndex: number = 0;
let pendingVariantIndex: number | null = null;
let pendingVariantUrl: string | null = null;

async function runHlsSession(url: string, startSeq?: number) {
  const { parseM3U8, parseMaster, timeToSeq } = await import('./hls/playlist');
  const { demuxTS } = await import('./ts/demux-ts');
  const { extractSpsPps, buildAVCCDesc } = await import('./bsf/h264-annexb-avcc');
  const { extractASC, getAdtsInfo } = await import('./bsf/aac-adts-raw');
  const { decryptAes128CbcPkcs7, seqToIv, hexToBytes } = await import('./hls/aes');
  const { classifyError, nextBackoff, resetBackoff } = await import('./hls/retry');
  let mediaUrl = url;
  // remember the master m3u8 url when a master playlist is detected
  let masterUrlStr: string | null = null;
  // ABR / fetch tuning
  let masterVariants: string[] | null = null;
  let currentVariantIndex = 0;
  let ewmaFetchMs: number | null = null;
  const EWMA_ALPHA = 0.2;
  // 当 VOD seek 刚发生后，尝试对首片做部分 Range 拉取以加速首画
  let justSeekedToSeq: number | null = null;
  let lastMediaSeq = (typeof startSeq === 'number' && Number.isFinite(startSeq)) ? (startSeq - 1) : -1;
  // 公共时间基（以本次会话首个样本为 0），确保音视频对齐
  let basePtsUs: number | null = null;
  let backoffMs = 500;
  const backoffMax = 6000;
  const backoffPolicy = { baseMs: 500, maxMs: backoffMax, jitter: 0.2 };
  let lastAudioCfg: { sr?: number; ch?: number; ascSig?: string | null } = {};
  let lastAvccSig: string | null = null;
  let lastParamSps: ArrayBuffer | null = null;
  let lastParamPps: ArrayBuffer | null = null;
  let injectParamFrames: number = 0; // 在参数更新后，前若干个关键帧内带内嵌 SPS/PPS
  let debugVidLogged = 0; // 仅打印前几条视频样本调试信息
  let debugAudLogged = 0; // 仅打印前几条音频样本调试信息
  let emptyAudioFrames = 0; // 统计空音频帧
  let declaredNoAudio = false; // 已告知主线程无音频
  let lastDurationMs: number | undefined = undefined; // HLS VOD 总时长
  let pendingKeyHandlerRunning = false; // 防止并行的 aggressiveKeySearch
  const livePoll = async (delayMs: number) => new Promise(r => setTimeout(r, delayMs));

  // aggressiveKeySearch will be defined later where demuxTS/keyBytes etc are in scope

  function toHex2(n: number) { return (n & 0xff).toString(16).padStart(2, '0').toUpperCase(); }
  function avcCodecFromSps(sps: Uint8Array | null | undefined): string | null {
    try {
      if (!sps || sps.length < 4) return null;
      // sps[0] is NAL header, next three are profile_idc, constraint_set*, level_idc
      const profile = sps[1];
      const constraint = sps[2];
      const level = sps[3];
      return `avc1.${toHex2(profile)}${toHex2(constraint)}${toHex2(level)}`;
    } catch { return null; }
  }

  // 解析 master（如有）到具体 media playlist
  async function resolveMedia(u: string): Promise<string> {
    const res = await fetch(u);
    const text = await res.text();
    if (/EXT-X-STREAM-INF/.test(text)) {
      const master = parseMaster(text, u);
      if (!master.length) throw new Error('HLS master has no variants');
      // record variant list for potential ABR
      try { masterVariants = master.map((m: any) => m.url); } catch(e) { masterVariants = master.map((m: any) => m.url); }
      currentVariantIndex = 0;
      // expose globally for UI
      try { gHlsVariants = masterVariants ? masterVariants.slice() : null; gHlsVariantIndex = currentVariantIndex; } catch {}
      // remember master url and post variants list to main thread
      masterUrlStr = u;
      try {
        const list = master.map((m: any, i: number) => ({ index: i, url: m.url }));
        postMain({ type: 'hls-variants', masterUrl: masterUrlStr, list });
        // also post initial selected variant (index 0) for UI awareness
        postMain({ type: 'hls-variant', masterUrl: masterUrlStr, url: master[0].url, variantIndex: 0 });
      } catch {}
      return master[0].url;
    }
    return u;
  }

  mediaUrl = await resolveMedia(mediaUrl);
  currentMode = 'hls';
  postMain({ type: 'log', msg: 'HLS: media=' + mediaUrl });

  while (!hlsAbort) {
  // HLS main loop: fetch playlist, pull segments, demux and post samples
      // Apply pending manual variant switch (from UI) if any
  if (masterVariants && (pendingVariantIndex !== null || pendingVariantUrl)) {
        try {
          if (typeof pendingVariantIndex === 'number' && pendingVariantIndex >= 0 && pendingVariantIndex < masterVariants.length) {
            currentVariantIndex = pendingVariantIndex;
            mediaUrl = masterVariants[currentVariantIndex];
            gHlsVariantIndex = currentVariantIndex;
    postMain({ type: 'hls-variant', masterUrl: masterUrlStr || mediaUrl, url: mediaUrl, variantIndex: currentVariantIndex });
          } else if (pendingVariantUrl) {
            const idx = masterVariants.indexOf(pendingVariantUrl);
            mediaUrl = pendingVariantUrl;
            if (idx >= 0) { currentVariantIndex = idx; gHlsVariantIndex = idx; }
    postMain({ type: 'hls-variant', masterUrl: masterUrlStr || mediaUrl, url: mediaUrl, variantIndex: currentVariantIndex });
          }
        } catch {}
        pendingVariantIndex = null; pendingVariantUrl = null;
      }
      const res = await fetch(mediaUrl, { cache: 'no-store' as RequestCache });
      if (!res.ok) throw new Error('playlist http ' + res.status);
      const text = await res.text();
      const parsed = parseM3U8(text, mediaUrl);
  const target = parsed.targetDuration || 4;
  const isEnd = !!parsed.endList || parsed.playlistType === 'VOD';

      // 若为点播（有 ENDLIST），统计总时长并上报（避免 UI 显示 0）
  if (isEnd && Array.isArray(parsed.segments) && parsed.segments.length) {
        try {
          const totalMs = Math.round(parsed.segments.reduce((s: number, seg: any) => s + (Number(seg.duration) || 0), 0) * 1000);
          if (!Number.isNaN(totalMs) && totalMs > 0 && totalMs !== lastDurationMs) {
            lastDurationMs = totalMs;
            postMain({ type: 'duration', ms: totalMs });
          }
        } catch {}
      }

    // 处理 VOD seek：根据累积时长映射到 seq
    if (isEnd && typeof pendingHlsSeekMs === 'number' && pendingHlsSeekMs >= 0) {
        try {
      const ms = pendingHlsSeekMs;
      const chosenSeq = timeToSeq(parsed.segments, parsed.mediaSequence, ms);
      lastMediaSeq = Math.max(parsed.mediaSequence, chosenSeq - 1);
          basePtsUs = null;
          injectParamFrames = 0;
      // 标记刚刚 seek 到的 seq，用于首片 Range 快速拉取尝试
      justSeekedToSeq = lastMediaSeq + 1;
      postMain({ type: 'log', msg: `HLS VOD seek -> seq=${lastMediaSeq + 1} (ms=${ms})` });
        } catch {}
        pendingHlsSeekMs = null;
      }

  // 初次或刷新：只拉新的分片，但限制前瞻以避免一次性串行拉取全部分片
  const startSeq = Math.max(parsed.mediaSequence, lastMediaSeq + 1);
  const newSegsAll = parsed.segments.filter(s => s.seq >= startSeq);
  // 根据目标分片时长计算前瞻分片数，保底 1 片
  // 目标：按需拉片，前瞻限制在 1~3 秒，避免一次拉完所有分片
  const segDurMs = (parsed.targetDuration || target) * 1000;
  let lookAheadMs = Math.max(1000, Math.min(3000, Math.round(segDurMs * 2)));
  // 对于非常短的段可稍微增加上限一小段，但仍不超过 3s
  const lookAheadCount = Math.max(1, Math.min(12, Math.ceil(lookAheadMs / Math.max(1, segDurMs))));
  const lookBehindCount = 1; // 允许回拉小量历史分片
  const newSegs = newSegsAll.slice(0, lookAheadCount + lookBehindCount);
  if (newSegs.length === 0) {
        // 没有新分片：直播轮询或点播结束
        if (isEnd) break;
        await livePoll(Math.min(Math.max(target * 1000 * 0.5, 500), 3000));
        continue;
      }

  // AES-128 密钥（只支持“当前 key”场景）
  let keyBytes: Uint8Array | undefined;
  let ivFixed: Uint8Array | undefined;
      if (parsed.key && parsed.key.method === 'SAMPLE-AES') {
        postMain({ type: 'error', msg: 'HLS SAMPLE-AES unsupported, cannot decrypt without EME. Downgrading/aborting.' });
        hlsAbort = true; break; // 明确降级策略：直接终止本会话
      }
      if (parsed.key && parsed.key.method === 'AES-128' && parsed.key.uri) {
        const keyRes = await fetch(new URL(parsed.key.uri, mediaUrl).href);
        keyBytes = new Uint8Array(await keyRes.arrayBuffer());
        if (parsed.key.ivHex) ivFixed = hexToBytes(parsed.key.ivHex);
      }

  // 实现：当 pendingKeyRequest 被置位时，启动一个后台的 aggressiveKeySearch
  async function aggressiveKeySearch() {
    if (pendingKeyHandlerRunning) return;
    pendingKeyHandlerRunning = true;
    try {
      const maxAttempts = 12;
      let attempts = 0;
      while (pendingKeyRequest && !hlsAbort && attempts < maxAttempts) {
        attempts++;
        try {
          const r2 = await fetch(mediaUrl, { cache: 'no-store' as RequestCache });
          if (!r2.ok) break;
          const txt2 = await r2.text();
          const parsed2 = parseM3U8(txt2, mediaUrl);
          const seqStart = Math.max(parsed2.mediaSequence, lastMediaSeq + 1);
          const candidates = (parsed2.segments || []).filter((s: any) => s.seq >= seqStart).slice(0, 6);
          if (!candidates || candidates.length === 0) { await livePoll(200); continue; }
          for (const s of candidates) {
            if (!pendingKeyRequest || hlsAbort) break;
            try {
              const rr = await fetch(s.uri, { cache: 'no-store' as RequestCache });
              let ab2 = await rr.arrayBuffer();
              if (keyBytes) {
                const iv = ivFixed || seqToIv(s.seq);
                ab2 = await decryptAes128CbcPkcs7(ab2, keyBytes, iv);
              }
              const samples2 = demuxTS(ab2);
              const vid2 = samples2.find((x: any) => x.kind === 'video' && !!x.key);
              if (vid2) { postMain({ type: 'key-found', seq: s.seq, ts: vid2.tsUs }); pendingKeyRequest = false; break; }
              else { postMain({ type: 'key-not-found', seq: s.seq }); }
            } catch (e) { /* best-effort */ }
          }
        } catch (e) { /* ignore and retry */ }
        await livePoll(200);
      }
    } finally { pendingKeyHandlerRunning = false; }
  }

  for (const seg of newSegs) {
        if (hlsAbort) break;
        try {
          // measure fetch time for EWMA / ABR
          const fetchStart = Date.now();
          let ab: ArrayBuffer;
          // VOD fast-start: 若刚刚 seek 到本分片，尝试部分 Range 拉取以尽快找到关键帧
          if (isEnd && justSeekedToSeq === seg.seq) {
            try {
              const rangeBytes = 128 * 1024; // 128KB
              const r = await fetch(seg.uri, { cache: 'no-store' as RequestCache, headers: { 'Range': `bytes=0-${rangeBytes}` } as any });
              if (r.status === 206 || r.ok) {
                const part = await r.arrayBuffer();
                // 尝试 demux on partial data to find keyframe; if found, post samples and continue background fetch
                try {
                  const samplesPart = demuxTS(part);
                  const vid = samplesPart.find((s: any) => s.kind === 'video' && !!s.key);
                  if (vid) {
                    // post partial samples and mark that remainder should be fetched later
                    for (const s of samplesPart) {
                      try { postMain({ type: 'sample', kind: s.kind, ts: (s as any).tsUs, dur: (s as any).durUs, key: s.key, data: s.data }, [s.data]); } catch {}
                    }
                    // background full fetch
                    (async () => {
                      try {
                        const rf = await fetch(seg.uri, { cache: 'no-store' as RequestCache });
                        let ab2 = await rf.arrayBuffer();
                        if (keyBytes) {
                          const iv = ivFixed || seqToIv(seg.seq);
                          ab2 = await decryptAes128CbcPkcs7(ab2, keyBytes, iv);
                        }
                        const samples2 = demuxTS(ab2);
                        for (const s2 of samples2) {
                          try { postMain({ type: 'sample', kind: s2.kind, ts: (s2 as any).tsUs, dur: (s2 as any).durUs, key: s2.key, data: s2.data }, [s2.data]); } catch {}
                        }
                      } catch (e) { /* ignore background failure */ }
                    })().catch(()=>{});
                    justSeekedToSeq = null;
                    // report fetch stats for partial as a small fetch
                    const fetchMs = Math.max(1, Date.now() - fetchStart);
                    postMain({ type: 'hls-download-stats', seq: seg.seq, fetchMs, segDurMs: Math.round((seg.duration || 0) * 1000) });
                    lastMediaSeq = seg.seq;
                    try { postMain({ type: 'hls-pos', seq: lastMediaSeq }); } catch {}
                    backoffMs = resetBackoff(backoffPolicy);
                    continue; // proceed to next
                  }
                } catch (e) { /* partial demux failed, will fallback to full fetch below */ }
              }
            } catch (e) { /* ignore partial fetch errors */ }
          }
          const r = await fetch(seg.uri, { cache: 'no-store' as RequestCache });
          ab = await r.arrayBuffer();
          if (keyBytes) {
            const iv = ivFixed || seqToIv(seg.seq);
            ab = await decryptAes128CbcPkcs7(ab, keyBytes, iv);
          }
          const fetchMs = Math.max(1, Date.now() - fetchStart);
          // update EWMA
          try {
            ewmaFetchMs = (ewmaFetchMs === null) ? fetchMs : Math.round(EWMA_ALPHA * fetchMs + (1 - EWMA_ALPHA) * ewmaFetchMs);
            postMain({ type: 'hls-download-stats', seq: seg.seq, fetchMs, ewmaFetchMs, segDurMs: Math.round((seg.duration || 0) * 1000) });
            // simple down-only ABR: if ewma fetch time significantly larger than seg duration, and lower variant exists, switch down
            const segDur = Math.max(1, Math.round((seg.duration || 0) * 1000));
      if (masterVariants && masterVariants.length > 1 && ewmaFetchMs !== null) {
              const ratio = ewmaFetchMs / Math.max(1, segDur);
              if (ratio > 1.4 && currentVariantIndex < masterVariants.length - 1) {
                // switch to a lower-quality variant (higher index => lower quality assuming master is ordered high->low)
                currentVariantIndex = Math.min(masterVariants.length - 1, currentVariantIndex + 1);
                mediaUrl = masterVariants[currentVariantIndex];
        postMain({ type: 'hls-variant', masterUrl: masterUrlStr || mediaUrl, url: mediaUrl, variantIndex: currentVariantIndex });
                // break to allow playlist refresh & reduce in-flight
                break;
              }
            }
          } catch (e) { /* ignore ewma/abr errors */ }
          const samples = demuxTS(ab);
          // 如果主线程请求寻找关键帧，优先扫描本分片 samples 是否包含关键帧
          if (pendingKeyRequest) {
            try {
              const vid = samples.find((s: any) => s.kind === 'video' && !!s.key);
              if (vid) {
                // 返回发现的关键帧信息（相对本会话 epoch 的 tsUs）
                postMain({ type: 'key-found', seq: seg.seq, ts: vid.tsUs });
                pendingKeyRequest = false;
              } else {
                // 如果本分片没有关键帧，通知主线程继续等待或尝试下一片
                postMain({ type: 'key-not-found', seq: seg.seq });
              }
            } catch (e) { /* best-effort */ }
            // 并行触发后台 aggressiveKeySearch，以便更主动地预取后续分片寻找关键帧
            try { aggressiveKeySearch().catch(()=>{}); } catch {}
          }
          // 排序：优先按 dtsUs，其次按 tsUs
          samples.sort((a: any, b: any) => (a.dtsUs ?? a.tsUs) - (b.dtsUs ?? b.tsUs));

          // 规范化视频时间戳：保证 tsUs/dtsUs 单调递增，并填充每帧 durUs
          try {
            const vids: any[] = samples.filter((x: any) => x.kind === 'video');
            if (vids.length > 0) {
              // 估算帧间隔：取相邻正差值的众数/最小值，若缺失则回退到 33ms
              const diffs: number[] = [];
              for (let i = 1; i < vids.length; i++) {
                const a = vids[i - 1]; const b = vids[i];
                const da = (typeof a.tsUs === 'number' && typeof b.tsUs === 'number') ? (b.tsUs - a.tsUs) : 0;
                if (da > 0) diffs.push(da);
              }
              let frameDurUs = 33333; // fallback ~30fps
              if (diffs.length > 0) {
                // 选择较小的代表值，避免由于 B 帧间隔过大导致估算过大
                frameDurUs = Math.max(1000, Math.min(...diffs));
              }
              // 强制单调并填充 durUs
              for (let i = 0; i < vids.length; i++) {
                const cur = vids[i];
                if (i > 0) {
                  const prev = vids[i - 1];
                  if (!(typeof cur.tsUs === 'number')) cur.tsUs = prev.tsUs + frameDurUs;
                  if (cur.tsUs <= prev.tsUs) cur.tsUs = prev.tsUs + frameDurUs;
                  // dtsUs 若缺失或回退，同样校正
                  if (typeof cur.dtsUs !== 'number') cur.dtsUs = cur.tsUs;
                  if (cur.dtsUs <= (prev.dtsUs ?? prev.tsUs)) cur.dtsUs = (prev.dtsUs ?? prev.tsUs) + frameDurUs;
                  // 为前一帧推导 durUs
                  prev.durUs = Math.max(0, Math.round(cur.tsUs - prev.tsUs));
                } else {
                  // 首帧如无 dts/ts，给定 0
                  if (typeof cur.tsUs !== 'number') cur.tsUs = 0;
                  if (typeof cur.dtsUs !== 'number') cur.dtsUs = cur.tsUs;
                }
              }
              // 为最后一帧给一个估算的 duration，避免 0
              const last = vids[vids.length - 1];
              if (typeof last.durUs !== 'number' || last.durUs <= 0) last.durUs = frameDurUs;
            }
          } catch {}

          // DISCONTINUITY：重置时间基
          if (seg.discontinuity) { basePtsUs = null; }

          // 尝试在每个分片开始提取 SPS/PPS 并下发运行时配置（仅一次或发生变化时）
          try {
            const firstV = samples.find((s: any) => s.kind === 'video');
            if (firstV) {
              const { sps, pps } = extractSpsPps(firstV.data);
        if (sps.length && pps.length) {
                const avcc = buildAVCCDesc(new Uint8Array(sps[0]), new Uint8Array(pps[0]));
                // 计算签名避免重复下发
                let sig = '';
                try { sig = Array.from(avcc).slice(0, 32).join(',') + '|' + avcc.length; } catch {}
        if (sig !== lastAvccSig) {
                  lastAvccSig = sig;
          const codec = avcCodecFromSps(new Uint8Array(sps[0])) || 'avc1.42E01E';
          lastParamSps = sps[0];
          lastParamPps = pps[0];
          injectParamFrames = 12; // 扩大到前 12 个关键帧注入参数集，提升首播稳定性
  postMain({ type: 'log', msg: `video config-update codec=${codec} descLen=${avcc.length}` });
  // 发送 codec + description，并标记 annexb，主线程可选择忽略 description
  postMain({ type: 'config-update', video: { codec, description: avcc, annexb: true } });
                }
              }
            }
          } catch {}

          // 音频配置探测（若采样率/声道有变化）
          try {
            const firstA: any = samples.find((s: any) => s.kind === 'audio');
            if (firstA) {
              // Prefer demux-provided metadata (sr/ch/asc on RAW AAC sample). Fallback to ADTS sniff if any.
              let sr = (firstA as any).sr as number | undefined;
              let ch = (firstA as any).ch as number | undefined;
              let asc: ArrayBuffer | undefined = (firstA as any).asc as ArrayBuffer | undefined;
              if ((!sr || !ch) && firstA.data) {
                const info = getAdtsInfo(new Uint8Array(firstA.data));
                if (info) { sr = sr || info.sampleRate; ch = ch || info.channels; }
              }
              if (!asc && firstA.data) {
                try { const a = await extractASC(firstA.data); if (a && (a as ArrayBuffer).byteLength) asc = a as ArrayBuffer; } catch {}
              }
              const ascSig = asc ? ((): string => { try { const u8 = new Uint8Array(asc!); return Array.from(u8.slice(0, 8)).join(',') + '|' + u8.length; } catch { return 'n/a'; } })() : null;
              const needUpdate = (typeof sr === 'number' && sr !== lastAudioCfg.sr) || (typeof ch === 'number' && ch !== lastAudioCfg.ch) || (ascSig !== lastAudioCfg.ascSig);
              if (needUpdate) {
                lastAudioCfg = { sr, ch, ascSig };
                const audioCfg: any = { codec: 'mp4a.40.2' };
                if (typeof sr === 'number') audioCfg.sampleRate = sr;
                if (typeof ch === 'number') audioCfg.numberOfChannels = ch;
                if (asc && (asc as ArrayBuffer).byteLength) audioCfg.description = asc;
                postMain({ type: 'config-update', audio: audioCfg });
              }
            }
          } catch {}

          // 旧的简单 dur 估算已由上面的规范化逻辑替代

          let vCount = 0, aCount = 0;
          for (const s of samples) {
            const tsUs = (s as any).tsUs as number;
            const durUs = (s as any).durUs as number;
            const dtsUs = (s as any).dtsUs as number | undefined;
            // 建立公共基准：采用首个出现的样本时间戳
            if (basePtsUs === null) basePtsUs = tsUs;
            const outTs = tsUs - (basePtsUs || 0);
            let outDts = (typeof dtsUs === 'number') ? (dtsUs - (basePtsUs || 0)) : undefined;
            // 防御性处理：若 dts 与 pts 偏差过大或非法，回退使用 pts
            if (typeof outDts === 'number') {
              const diff = outDts - outTs;
              if (!isFinite(diff) || Math.abs(diff) > 5_000_000 || outDts < 0) outDts = outTs;
            }
            let data = s.data;
            // 若需要，在关键帧前注入参数集（SPS/PPS）
            if (s.kind === 'video') {
              vCount++;
              if (s.key && injectParamFrames > 0 && lastParamSps && lastParamPps) {
                try {
                  const sps = new Uint8Array(lastParamSps); const pps = new Uint8Array(lastParamPps);
                  const prefixLen = 4 + sps.length + 4 + pps.length; // 00 00 00 01 + sps + 00 00 00 01 + pps
                  const body = new Uint8Array(data);
                  const out = new Uint8Array(prefixLen + body.length);
                  let o = 0; out.set([0,0,0,1], o); o+=4; out.set(sps, o); o+=sps.length; out.set([0,0,0,1], o); o+=4; out.set(pps, o); o+=pps.length; out.set(body, o);
                  data = out.buffer;
                  injectParamFrames--;
                } catch {}
              }
              // 打印前几条视频样本关键调试信息（仅一次性少量）
              if (debugVidLogged < 6) {
                try {
                  const len = (data as ArrayBuffer).byteLength || 0;
                  const tsu = Math.max(0, Math.trunc((s as any).tsUs ?? 0));
                  const dtsu = (s as any).dtsUs !== undefined ? Math.max(0, Math.trunc((s as any).dtsUs)) : -1;
                  postMain({ type: 'log', msg: `dbg[v] key=${!!s.key} tsUs=${tsu} dtsUs=${dtsu} len=${len}` });
                } catch {}
                debugVidLogged++;
              }
            } else {
              // 音频：过滤空样本，必要时宣布无音频
              const len = (data as ArrayBuffer)?.byteLength || 0;
              if (len <= 0) {
                emptyAudioFrames++;
                if (!declaredNoAudio && emptyAudioFrames >= 10) {
                  try { postMain({ type: 'stream-info', hasAudio: false, hasVideo: true }); } catch {}
                  declaredNoAudio = true;
                }
                continue; // 跳过空音频
              }
              aCount++;
            }
            const payload: any = { type: 'sample', kind: s.kind, ts: outTs, dur: durUs, key: s.key, data };
            if (typeof outDts === 'number') payload.dts = outDts;
            if ((s as any).pcrUs !== undefined) {
              try {
                const pcrRel = (s as any).pcrUs - (basePtsUs || 0);
                const ok = Number.isFinite(pcrRel) && Math.abs(pcrRel - outTs) <= 5_000_000 && pcrRel >= -1_000_000;
                if (ok) (payload as any).pcr = pcrRel;
              } catch {}
            }
            postMain(payload, [data as ArrayBuffer]);
            // 打印前几条音频样本调试信息
            if (s.kind === 'audio' && debugAudLogged < 6) {
              try {
                const len = (data as ArrayBuffer).byteLength || 0;
                const tsu = Math.max(0, Math.trunc((s as any).tsUs ?? 0));
                const duu = Math.max(0, Math.trunc((s as any).durUs ?? 0));
                postMain({ type: 'log', msg: `dbg[a] tsUs=${tsu} durUs=${duu} len=${len} sr=${(s as any).sr||'?'} ch=${(s as any).ch||'?'}` });
              } catch {}
              debugAudLogged++;
            }
          }
          lastMediaSeq = seg.seq;
          try { postMain({ type: 'log', msg: `posted samples v=${vCount} a=${aCount} seq=${lastMediaSeq}` }); } catch {}
          try { postMain({ type: 'hls-pos', seq: lastMediaSeq }); } catch {}
          backoffMs = resetBackoff(backoffPolicy); // 成功后恢复较小的等待
        } catch (e) {
          const cat = classifyError(e);
          postMain({ type: 'log', msg: `HLS segment failed(${cat}): ${String(e)} @seq=${seg.seq}` });
          // 分类退避
          await livePoll(backoffMs);
          backoffMs = nextBackoff(backoffMs, backoffPolicy);
        }
      }

      if (!isEnd) {
        await livePoll(Math.min(target * 1000, 4000));
        continue;
      }
  // VOD 结束
  break;
  }
}
// Worker entry (TypeScript skeleton). This file should be compiled/bundled to worker.js for runtime.

type WorkerMessage = any;

function postMain(msg: WorkerMessage, transfer?: Transferable[]) {
  try { (self as any).postMessage(msg, transfer || []); }
  catch (e) { /* best-effort */ }
}

// Load mp4box runtime into worker scope by fetching the UMD build and evaluating it.
async function ensureMp4box() {
  if ((self as any).MP4Box) return (self as any).MP4Box;
  try {
    const url = 'https://cdn.jsdelivr.net/npm/mp4box@0.5.4/dist/mp4box.all.min.js';
    const r = await fetch(url);
    const txt = await r.text();
    // evaluate in worker scope
    // eslint-disable-next-line no-eval
    (0, eval)(txt);
    return (self as any).MP4Box;
  } catch (e) {
    postMain({ type: 'log', msg: 'mp4box load failed ' + String(e) });
    return null;
  }
}

// parse esds buffer (Uint8Array) to extract AudioSpecificConfig (ASC), sampleRate and channels
function parseEsdsSimple(esdsBuf: Uint8Array | ArrayBuffer | null) {
  if (!esdsBuf) return null;
  try {
    const u8 = esdsBuf instanceof Uint8Array ? esdsBuf : new Uint8Array(esdsBuf as ArrayBuffer);
    let i = 0;
    while (i < u8.length) {
      const tag = u8[i++];
      let len = 0; let shift = 0;
      while (i < u8.length) {
        const b = u8[i++];
        len |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
      }
      if (tag === 0x05) {
        const asc = u8.subarray(i, i + len);
        if (asc && asc.length >= 2) {
          const v0 = asc[0], v1 = asc[1];
          const samplingFreqIndex = ((v0 & 0x07) << 1) | ((v1 >> 7) & 0x01);
          const channelConfig = (v1 >> 3) & 0x0f;
          const samplingFrequencies = [96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350];
          const sampleRate = samplingFrequencies[samplingFreqIndex] || 48000;
          return { asc: asc.slice(0), sampleRate, channels: channelConfig };
        }
        return { asc: asc.slice(0), sampleRate: 48000, channels: 2 };
      }
      i += len;
    }
  } catch (e) { /* ignore */ }
  return null;
}

/** Simple mp4box setup helper that configures onReady/onSamples with safer defaults */
function setupMp4Box(mp4box: any) {
  let vTrack: any = null;
  let aTrack: any = null;
  mp4box.onError = (e: any) => postMain({ type: 'log', msg: 'mp4box error ' + String(e) });
  mp4box.onReady = (infoBox: any) => {
    postMain({ type: 'log', msg: 'mp4box ready tracks=' + (infoBox.tracks ? infoBox.tracks.length : 0) });
    vTrack = infoBox.tracks && infoBox.tracks.find((t: any) => t.type === 'video');
    aTrack = infoBox.tracks && infoBox.tracks.find((t: any) => t.type === 'audio');
    // compute durationMs if available
    let durationMs: number | null = null;
    try {
      if (infoBox && infoBox.duration && infoBox.timescale) durationMs = Math.round(infoBox.duration * 1000 / infoBox.timescale);
      else if (vTrack && vTrack.duration && vTrack.timescale) durationMs = Math.round(vTrack.duration * 1000 / vTrack.timescale);
      else if (aTrack && aTrack.duration && aTrack.timescale) durationMs = Math.round(aTrack.duration * 1000 / aTrack.timescale);
    } catch (e) { /* ignore */ }

    // increase nbSamples to avoid too-frequent callbacks
    if (vTrack) mp4box.setExtractionOptions(vTrack.id, null, { nbSamples: 20 });
    if (aTrack) mp4box.setExtractionOptions(aTrack.id, null, { nbSamples: 50 });
    mp4box.start();

    // helper: try to parse esds to extract AudioSpecificConfig (ASC) and channel/sampleRate
    function parseEsds(esdsBuf: Uint8Array | null) {
      if (!esdsBuf) return null;
      try {
        // simple ESDS parsing: find 0x05 tag (DecoderSpecificInfo) and read following length-prefixed bytes
        const u8 = esdsBuf;
        let i = 0;
        while (i < u8.length) {
          const tag = u8[i++];
          // read length (could be multi-byte with 0x80 continuation)
          let len = 0; let shift = 0;
          while (i < u8.length) {
            const b = u8[i++];
            len |= (b & 0x7f) << shift;
            if ((b & 0x80) === 0) break;
            shift += 7;
          }
          if (tag === 0x05) {
            // DecoderSpecificInfo -> AudioSpecificConfig
            const asc = u8.subarray(i, i + len);
            // parse asc: first 5 bits object type, next 4 bits sampling freq index, next 4 bits channel config
            if (asc && asc.length >= 2) {
              const v0 = asc[0];
              const v1 = asc[1];
              const objectType = (v0 >> 3) & 0x1f;
              const samplingFreqIndex = ((v0 & 0x07) << 1) | ((v1 >> 7) & 0x01);
              const channelConfig = (v1 >> 3) & 0x0f;
              const samplingFrequencies = [96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350];
              const sampleRate = samplingFrequencies[samplingFreqIndex] || 48000;
              return { asc: asc.slice(0), sampleRate, channels: channelConfig };
            }
            return { asc: asc.slice(0), sampleRate: 48000, channels: 2 };
          }
          i += len;
        }
      } catch (e) { /* ignore */ }
      return null;
    }

    // try to produce video/audio config to main
    try {
      if (vTrack) {
        // mp4box stores some codec data under track.boxes; try to extract avcC if present
        const extra = (vTrack.extra && typeof vTrack.extra.avcc !== 'undefined') ? vTrack.extra.avcc : null;
        // fallback to mp4box's internal structure if available (best-effort)
        const codec = vTrack.codec || null;
        const desc = extra || null;
        // audio info: try to extract esds from aTrack boxes if available
        let audioInfo: any = null;
        if (aTrack) {
          audioInfo = { codec: aTrack.codec };
          if (aTrack.extra && aTrack.extra.esds) audioInfo.esds = aTrack.extra.esds;
          // attempt to parse esds -> asc, sampleRate, channels
          if (audioInfo.esds) {
            const parsed = parseEsds(audioInfo.esds instanceof Uint8Array ? audioInfo.esds : new Uint8Array(audioInfo.esds));
            if (parsed) {
              audioInfo.asc = parsed.asc;
              audioInfo.sampleRate = parsed.sampleRate;
              audioInfo.numberOfChannels = parsed.channels;
            }
          }
        }
        postMain({ type: 'ready-mp4', info: { video: desc ? { codec, description: desc } : (vTrack ? { codec } : null), audio: audioInfo, durationMs } });
      } else {
        let audioInfo = null;
        if (aTrack) audioInfo = { codec: aTrack.codec };
        postMain({ type: 'ready-mp4', info: { video: null, audio: audioInfo, durationMs } });
      }
    } catch (e) { postMain({ type: 'log', msg: 'ready-mp4 post failed ' + String(e) }); }
  };

  mp4box.onSamples = async (id: any, user: any, samples: any[]) => {
    postMain({ type: 'log', msg: 'mp4box onSamples id=' + id + ' count=' + samples.length });
    for (const s of samples) {
      try {
        const isV = vTrack && id === vTrack.id;
        const timescale = isV ? vTrack.timescale : (aTrack ? aTrack.timescale : 90000);
        const ts = Math.round((s.cts || s.dts || 0) / timescale * 1e6);
        const dur = Math.round((s.duration || 0) / timescale * 1e6);
        const key = !!s.is_sync;
        // ensure a standalone ArrayBuffer for mp4box-provided sample data
        let data = s.data && s.data.buffer ? s.data.buffer.slice(s.data.byteOffset || 0, (s.data.byteOffset || 0) + (s.data.byteLength || s.data.length || 0)) : (s.data && s.data.slice ? s.data.slice(0) : s.data);
        if (isV) {
          try { const mod = await import('./mp4/demux-mp4'); data = mod.avccToAnnexB(data, 4); } catch (e) { /* noop */ }
        }
        postMain({ type: 'sample', kind: isV ? 'video' : 'audio', ts, dur, key, data }, [data]);
      } catch (e) { postMain({ type: 'log', msg: 'mp4box post sample failed ' + String(e) }); }
    }
  };
}

self.addEventListener('message', (ev: MessageEvent) => {
  const msg: any = ev.data;
  switch (msg.type) {
    case 'setHlsVariant': {
      try {
        if (typeof msg.index === 'number') pendingVariantIndex = Math.floor(Math.max(0, msg.index));
        else if (typeof msg.url === 'string') pendingVariantUrl = String(msg.url);
        postMain({ type: 'log', msg: 'setHlsVariant received' });
      } catch (e) { postMain({ type: 'log', msg: 'setHlsVariant failed ' + String(e) }); }
      break;
    }
    case 'openHLS':
      hlsAbort = false;
      // 如果提供了 VOD 起播时间，则让 HLS 会话从接近该时间的分片开始
      if (typeof msg.startAtMs === 'number') {
        try { pendingHlsSeekMs = Math.max(0, Number(msg.startAtMs) || 0); } catch {}
      }
      runHlsSession(msg.url, msg.startSeq);
      break;
    case 'fetchSegment':
      (async () => {
        try {
          const { demuxTS } = await import('./ts/demux-ts');
          const r = await fetch(msg.uri);
          const ab = await r.arrayBuffer();
          const samples = demuxTS(ab);
          for (const s of samples) {
            postMain({ type: 'sample', kind: s.kind, ts: (s as any).tsUs, dur: (s as any).durUs, key: s.key, data: s.data }, [s.data]);
          }
        } catch (e) { postMain({ type: 'log', msg: 'fetchSegment failed ' + String(e) }); }
      })();
      break;
    case 'seek':
      (async () => {
        try {
          const ms = Math.max(0, Number(msg.ms) || 0);
          if (currentMode === 'hls') {
            pendingHlsSeekMs = ms;
            postMain({ type: 'log', msg: `seek(HLS) requested ms=${ms}` });
            return;
          }
          if (currentMode === 'mp4' && mp4Session && mp4Session.mp4box) {
            try {
              (mp4Session.mp4box as any).seek(ms / 1000, true);
              postMain({ type: 'log', msg: `seek(MP4) to ${(ms/1000).toFixed(3)}s requested` });
            } catch (e) { postMain({ type: 'log', msg: 'mp4box seek failed ' + String(e) }); }
            return;
          }
          postMain({ type: 'log', msg: 'seek ignored: no active session' });
        } catch (e) { postMain({ type: 'log', msg: 'seek handler error ' + String(e) }); }
      })();
      break;

    case 'requestKey':
      (async () => {
        try {
          // 主线程请求尽快定位下一个关键帧：设置标志，HLS 拉取循环会在分片解析时检测并回报
          pendingKeyRequest = true;
          postMain({ type: 'log', msg: 'worker: requestKey acknowledged' });
        } catch (e) { postMain({ type: 'log', msg: 'requestKey handler failed ' + String(e) }); }
      })();
      break;

    case 'open':
      (async () => {
        try {
          const url = msg.url;
          postMain({ type: 'log', msg: 'fetching mp4 ' + url });
          const buf = await fetch(url).then(r => r.arrayBuffer());

          // prefer MP4Box parsing for robustness
      const MP4Box = await ensureMp4box();
          if (MP4Box) {
            try {
              const mp4box = (MP4Box as any).createFile();
              setupMp4Box(mp4box);
        mp4Session = { mp4box };
        currentMode = 'mp4';

              // feed mp4box with properly sliced ArrayBuffer and fileStart
              // for progressive fetch/read of the whole file
              const arr = new Uint8Array(buf);
              // create a sliced independent ArrayBuffer and set fileStart
              const ab = arr.buffer.slice(arr.byteOffset || 0, (arr.byteOffset || 0) + (arr.byteLength || arr.length));
              try { Object.defineProperty(ab, 'fileStart', { value: 0, writable: false, enumerable: true }); } catch(e) { (ab as any).fileStart = 0; }
              mp4box.appendBuffer(ab);
            } catch (e) { postMain({ type: 'log', msg: 'mp4box parse failed ' + String(e) }); }
            return;
          }

          // fallback to built-in parser
          try {
            const mod = await import('./mp4/demux-mp4');
            const info = mod.parseInit(buf);
            try {
              const hasVideo = !!(info && info.video && info.video.avcC);
              const hasAudio = !!(info && info.audio && info.audio.esds);
              const avccLen = hasVideo ? (info.video.avcC.byteLength || info.video.avcC.length || 0) : 0;
              const nalLen = (info && info.video && info.video.nalLengthSize) ? info.video.nalLengthSize : undefined;
              postMain({ type: 'log', msg: `mp4 init parsed hasVideo=${hasVideo} avcCLen=${avccLen} nalLen=${String(nalLen)} hasAudio=${hasAudio}` });
            } catch (e) { postMain({ type: 'log', msg: 'mp4 init log failed ' + String(e) }); }
            if (info && info.video && info.video.avcC) {
              const avcc = info.video.avcC;
              // enrich audio info if esds present
              if (info.audio && info.audio.esds) {
                const parsed = parseEsdsSimple(info.audio.esds instanceof Uint8Array ? info.audio.esds : new Uint8Array(info.audio.esds));
                if (parsed) {
                  info.audio.asc = parsed.asc;
                  info.audio.sampleRate = parsed.sampleRate;
                  info.audio.numberOfChannels = parsed.channels;
                }
              }
              postMain({ type: 'ready-mp4', info: { video: { codec: 'avc1', description: avcc }, audio: info.audio } });
            } else {
              if (info && info.audio && info.audio.esds) {
                const parsed = parseEsdsSimple(info.audio.esds instanceof Uint8Array ? info.audio.esds : new Uint8Array(info.audio.esds));
                if (parsed) {
                  info.audio.asc = parsed.asc;
                  info.audio.sampleRate = parsed.sampleRate;
                  info.audio.numberOfChannels = parsed.channels;
                }
              }
              postMain({ type: 'ready-mp4', info });
            }

            try {
              const samples = mod.parseFragment(buf, info);
              postMain({ type: 'log', msg: 'parseFragment found samples=' + (samples ? samples.length : 0) });
              if (!samples || samples.length === 0) {
                try {
                  postMain({ type: 'log', msg: 'parseFragment returned 0, scanning top-level boxes for mdat/moof...' });
                  const dv = new DataView(buf);
                  const top: string[] = [];
                  let off = 0;
                  while (off + 8 <= dv.byteLength) {
                    const s = dv.getUint32(off);
                    const t = String.fromCharCode(dv.getUint8(off+4), dv.getUint8(off+5), dv.getUint8(off+6), dv.getUint8(off+7));
                    top.push(t);
                    if (s <= 0) break;
                    off += s;
                  }
                  postMain({ type: 'log', msg: 'top-level boxes: ' + top.join(',') });
                } catch(e) { postMain({ type: 'log', msg: 'scan boxes failed ' + String(e) }); }
              }
              if (samples && samples.length) {
                const max = Math.min(samples.length, 20);
                for (let i = 0; i < max; i++) {
                  const s = samples[i];
                  try {
                    let data = s.data;
                    if (s.kind === 'video' && info && info.video && info.video.avcC) {
                      const helper = mod;
                      const nalSize = info.video.nalLengthSize || 4;
                      try { data = helper.avccToAnnexB(s.data, nalSize); } catch(e) { /* fallback */ }
                    }
                    postMain({ type: 'sample', kind: s.kind, ts: s.ts, dur: s.dur, key: s.key, data }, [data]);
                  } catch(e) { postMain({ type: 'log', msg: 'post sample failed ' + String(e) }); }
                }
                if (samples.length > max) postMain({ type: 'log', msg: 'only sent ' + max + ' of ' + samples.length + ' samples' });
              }
            } catch(e) { postMain({ type: 'log', msg: 'parseFragment failed ' + String(e) }); }
          } catch(e) { postMain({ type: 'log', msg: 'mp4 parse import error ' + String(e) }); }
        } catch(e) { postMain({ type: 'log', msg: 'open url error ' + String(e) }); }
      })();
      break;

    case 'openMP4':
      (async () => {
        try {
          const buf = msg.buffer;
          // if mp4box available, use it as well for init parsing
          const MP4Box = await ensureMp4box();
          if (MP4Box) {
            try {
              const mp4box = (MP4Box as any).createFile();
              setupMp4Box(mp4box);
              // ensure buffer is standalone and set fileStart if provided
              let ab = buf;
              try {
                const u8 = new Uint8Array(buf);
                ab = u8.buffer.slice(u8.byteOffset || 0, (u8.byteOffset || 0) + (u8.byteLength || u8.length));
                if (typeof msg.fileStart === 'number') Object.defineProperty(ab, 'fileStart', { value: msg.fileStart, writable: false, enumerable: true });
                else Object.defineProperty(ab, 'fileStart', { value: 0, writable: false, enumerable: true });
              } catch (e) { /* ignore slicing errors */ }
              mp4box.appendBuffer(ab);
              mp4box.flush();
              return;
            } catch (e) { postMain({ type: 'log', msg: 'openMP4 mp4box failed ' + String(e) }); }
          }

          const mod = await import('./mp4/demux-mp4');
          const info = mod.parseInit(buf);
          if (info && info.audio && info.audio.esds) {
            const parsed = parseEsdsSimple(info.audio.esds instanceof Uint8Array ? info.audio.esds : new Uint8Array(info.audio.esds));
            if (parsed) {
              info.audio.asc = parsed.asc;
              info.audio.sampleRate = parsed.sampleRate;
              info.audio.numberOfChannels = parsed.channels;
            }
          }
          postMain({ type: 'ready-mp4', info });
        } catch (e) { postMain({ type: 'log', msg: 'openMP4 failed ' + String(e) }); }
      })();
      break;

    case 'close':
      // close reader and mp4box instances if present
      try { postMain({ type: 'log', msg: 'worker: closing' }); } catch(e){}
  hlsAbort = true;
      currentMode = null;
      pendingHlsSeekMs = null;
      mp4Session = null;
      // Note: local mp4box instances are not kept global in this implementation; a production version should track and destroy them here.
      break;

    default:
      postMain({ type: 'log', msg: `worker: unknown message type ${String(msg && msg.type)}` });
  }
});

/** 检测 AnnexB AU 是否包含 IDR（NAL type=5） */
function h264HasIdr(annexB: Uint8Array): boolean {
  try {
    for (let i = 0; i < annexB.length; ) {
      const nalType = annexB[i] & 0x1f;
      const nalSize = (nalType === 7 || nalType === 8) ? 4 : 1; // SPS/PPS NAL 单独处理，其他默认 1 字节
      if (nalType === 5) return true; // IDR NAL
      i += nalSize + ((nalSize === 4) ? 0 : 1); // 00 00 00 01 前缀算 4 字节，其他情况算 1 字节
    }
  } catch {}
  return false;
}

// 在你封装/发送视频样本到主线程的位置（AU 组好后调用）
function postVideoSample(au: Uint8Array, ptsUs: number, dtsUs: number, durUs?: number) {
  try {
    // IDR 判断：快速检测关键帧
    const isKeyframe = h264HasIdr(au);
    const payload: any = { type: 'sample', kind: 'video', ts: ptsUs, dur: durUs, key: isKeyframe, data: au };
    if (typeof dtsUs === 'number') payload.dts = dtsUs;
    postMain(payload, [au.buffer]);
  } catch (e) { postMain({ type: 'log', msg: 'video sample post error ' + String(e) }); }
}
