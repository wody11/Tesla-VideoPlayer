// 辅助：从 ES 数据中提取 NALU（AnnexB 格式，支持 3/4 字节起始码）
function parseNALUs(es: Uint8Array): Uint8Array[] {
  const nalus: Uint8Array[] = [];
  let i = 0;
  const len = es.length;
  function isStartCode(pos: number): number {
    if (pos + 3 < len && es[pos] === 0 && es[pos+1] === 0) {
      if (es[pos+2] === 1) return 3;
      if (pos + 4 < len && es[pos+2] === 0 && es[pos+3] === 1) return 4;
    }
    return 0;
  }
  while (i < len) {
    // seek start code
    while (i < len && isStartCode(i) === 0) i++;
    const sc = isStartCode(i);
    if (!sc) break;
    const start = i + sc;
    i = start;
    // find next start code
    while (i < len && isStartCode(i) === 0) i++;
    const end = i;
    if (end > start) nalus.push(es.subarray(start, end));
  }
  return nalus;
}

// 辅助：判断 NALU 是否为 IDR（type 5）
function isIDR(nalu: Uint8Array): boolean {
  if (!nalu || nalu.length < 1) return false;
  const nalType = nalu[0] & 0x1f;
  return nalType === 5;
}
function isSlice(nalu: Uint8Array): boolean {
  if (!nalu || nalu.length < 1) return false;
  const t = nalu[0] & 0x1f;
  return t === 1 || t === 5;
}
// remove emulation prevention bytes and NAL header -> RBSP payload
function naluToRbsp(nalu: Uint8Array): Uint8Array {
  if (nalu.length <= 1) return new Uint8Array(0);
  const src = nalu.subarray(1);
  const out: number[] = [];
  let zeros = 0;
  for (let i = 0; i < src.length; i++) {
    const b = src[i];
    // 仅当出现 00 00 03 模式时去除 0x03
    if (zeros >= 2 && b === 0x03) { zeros = 0; continue; }
    out.push(b);
    if (b === 0x00) zeros++; else zeros = 0;
  }
  return new Uint8Array(out);
}
function readUE(rbsp: Uint8Array, bitOffsetRef: { v: number }): number {
  let zeros = 0;
  while (true) {
    const bit = readBits(rbsp, bitOffsetRef, 1);
    if (bit === 0) zeros++; else break;
    if (bitOffsetRef.v >= rbsp.length * 8) break;
  }
  const rest = zeros > 0 ? readBits(rbsp, bitOffsetRef, zeros) : 0;
  return (1 << zeros) - 1 + rest;
}
function readBits(buf: Uint8Array, ref: { v: number }, n: number): number {
  let val = 0;
  for (let i = 0; i < n; i++) {
    const bytePos = ref.v >> 3;
    const bitPos = 7 - (ref.v & 7);
    const bit = (buf[bytePos] >> bitPos) & 1;
    val = (val << 1) | bit;
    ref.v++;
  }
  return val;
}
function firstMbInSliceIsZero(nalu: Uint8Array): boolean {
  try {
    if (!isSlice(nalu)) return false;
    const rbsp = naluToRbsp(nalu);
    const ref = { v: 0 };
    const first_mb_in_slice = readUE(rbsp, ref);
    return first_mb_in_slice === 0;
  } catch { return false; }
}
import { adtsToRaw, getAdtsInfo, extractASC } from '../bsf/aac-adts-raw';
// MPEG-TS Demuxer (主流程骨架)
// 负责遍历 TS 包、校验同步字节、解析 PID、拼接 PES、提取 PTS/DTS，输出音视频 ES

export interface TSSample {
  kind: 'video' | 'audio';
  tsUs: number;
  durUs: number;
  key: boolean;
  data: ArrayBuffer;
  dtsUs?: number;
  pcrUs?: number;
  // optional audio metadata (for AAC RAW, since ADTS header was stripped)
  sr?: number;
  ch?: number;
  asc?: ArrayBuffer; // AudioSpecificConfig
}

export function demuxTS(buffer: ArrayBuffer): TSSample[] {
  const TS_PACKET_SIZE = 188;
  const SYNC_BYTE = 0x47;
  const samples: TSSample[] = [];
  const u8 = new Uint8Array(buffer);
  const len = u8.length;
  // PAT/PMT
  let pmtPid = -1;
  let vPid = -1, aPid = -1;
  // continuity counter per PID
  const ccMap: Record<number, number> = {};
  // PES assemble state per PID
  const pesChunks: Record<number, Uint8Array[]> = {};
  const pesPts: Record<number, number> = {};
  // PTS unwrap（按 PID 独立，避免音视频互相干扰）
  const PTS_MOD = 0x200000000; // 2^33
  const wrapOffsetMap: Record<number, number> = {};
  const lastPtsModMap: Record<number, number> = {};
  // optional: track last PCR in us for potential alignment
  let lastPcrUs: number | undefined = undefined;
  let haveSentKey = false; // 仅在见到首个关键帧后再开始输出视频样本
  function unwrapPts(pid: number, v: number): number {
    const lastPtsMod = lastPtsModMap[pid];
    let wrapOffset = wrapOffsetMap[pid] || 0;
    if (lastPtsMod !== undefined) {
      if (v < lastPtsMod && (lastPtsMod - v) > (PTS_MOD >> 1)) {
        wrapOffset += PTS_MOD;
      } else if (v > lastPtsMod && (v - lastPtsMod) > (PTS_MOD >> 1)) {
        wrapOffset -= PTS_MOD;
      }
    }
    lastPtsModMap[pid] = v;
    wrapOffsetMap[pid] = wrapOffset;
    return v + wrapOffset;
  }

  function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(total);
    let p = 0;
    for (const a of arrays) { out.set(a, p); p += a.length; }
    return out;
  }

  function readPtsFromPesHeader(pay: Uint8Array): { pts?: number; dts?: number; headerLen: number } {
    if (pay.length < 9 || pay[0] !== 0x00 || pay[1] !== 0x00 || pay[2] !== 0x01) return { headerLen: 0 };
    const flags = pay[7];
    const hdrLen = pay[8];
    let pts: number | undefined;
    let dts: number | undefined;
    if ((flags & 0x80) && hdrLen >= 5) {
      pts = ((pay[9] & 0x0e) << 29) | ((pay[10] & 0xff) << 22) | ((pay[11] & 0xfe) << 14) | ((pay[12] & 0xff) << 7) | ((pay[13] & 0xfe) >> 1);
    }
    if ((flags & 0x40) && hdrLen >= 10) {
      const b = 9 + 5;
      dts = ((pay[b] & 0x0e) << 29) | ((pay[b+1] & 0xff) << 22) | ((pay[b+2] & 0xfe) << 14) | ((pay[b+3] & 0xff) << 7) | ((pay[b+4] & 0xfe) >> 1);
    }
    return { pts, dts, headerLen: 9 + hdrLen };
  }

  function flushPes(pid: number) {
    const chunks = pesChunks[pid]; if (!chunks || chunks.length === 0) return;
    const esData = concatUint8Arrays(chunks);
    const pts90 = pesPts[pid] || 0;
  const ptsUnwrapped = unwrapPts(pid, pts90);
    if (pid === vPid) {
      const nalus = parseNALUs(esData);
      // 按 AUD(NAL type=9) 或 slice(首片) 分帧，确保每个 EncodedVideoChunk 对应一个 AU
      const groups: Uint8Array[][] = [];
      let cur: Uint8Array[] = [];
      let usedMarker = false;
      for (const n of nalus) {
        const t = n[0] & 0x1f;
        if (t === 9 || firstMbInSliceIsZero(n)) { // AUD 或者新的 slice 起始
          usedMarker = true;
          if (cur.length) groups.push(cur);
          cur = [n];
        } else {
          cur.push(n);
        }
      }
      if (cur.length) groups.push(cur);
  // 仅保留包含至少一个 slice 的 AU，避免仅有 SEI/AUD 的无效帧
  const auListRaw = usedMarker && groups.length ? groups : [nalus];
  const auList = auListRaw.filter(g => g && g.length && g.some(n => isSlice(n)));
      const dts = (pesPts as any)[pid + 0x100000] as number | undefined;
  const basePtsUs = Math.round(ptsUnwrapped * 1000000 / 90000);
  const baseDtsUs = dts !== undefined ? Math.round(unwrapPts(pid, dts) * 1000000 / 90000) : undefined;
      for (const g of auList) {
        if (!g || g.length === 0) continue;
        const isKey = g.some(n => isIDR(n));
        // 重新组装 AnnexB（为每个 NALU 加 4 字节起始码）
        // 确保每个 AU 前都有 AUD（NAL type=9），部分实现依赖 AUD 分帧
        const hasAud = g.some(n => (n[0] & 0x1f) === 9);
        const list: Uint8Array[] = hasAud ? g : [new Uint8Array([0x09, 0xF0]), ...g];
        const total = list.reduce((s, a) => s + 4 + a.length, 0);
        const buf = new Uint8Array(total);
        let p = 0;
        for (const a of list) { buf.set([0,0,0,1], p); p+=4; buf.set(a, p); p+=a.length; }
        if (buf.length >= 8) {
          if (!haveSentKey && !isKey) {
            // 首关键帧门禁：在遇到关键帧之前，不输出视频样本
          } else {
            samples.push({ kind: 'video', tsUs: basePtsUs, dtsUs: baseDtsUs, durUs: 0, key: isKey, data: buf.buffer, pcrUs: lastPcrUs });
            if (isKey && !haveSentKey) haveSentKey = true;
          }
        }
      }
    } else if (pid === aPid) {
      const raws = adtsToRaw(esData.slice().buffer);
      // 估算音频帧时长（ADTS 一般 1024 样本）并提取参数
      let durUs = 0;
      const info = getAdtsInfo(new Uint8Array(esData));
      if (info) durUs = Math.round(1024 * 1e6 / info.sampleRate);
      const asc = extractASC(esData.slice().buffer);
  const baseAudioUs = Math.round(ptsUnwrapped * 1000000 / 90000);
      for (let i = 0; i < raws.length; i++) {
        const raw = raws[i];
        // 将采样率/声道数/ASC 附带在样本上（便于主线程配置 WebCodecs AudioDecoder）
        const tsUs = baseAudioUs + i * durUs;
  samples.push({ kind: 'audio', tsUs, durUs, key: false, data: raw, sr: info?.sampleRate, ch: info?.channels, asc, pcrUs: lastPcrUs });
      }
    }
    pesChunks[pid] = [];
  }

  function parsePAT(payload: Uint8Array) {
    let p = 0;
    const pointer = payload[p++];
    p += pointer; if (p + 8 > payload.length) return;
    const tableId = payload[p++]; if (tableId !== 0x00) return;
    const sectionLen = ((payload[p] & 0x0f) << 8) | payload[p+1]; p += 2;
    p += 5; // tsid + version + section num + last section num
    const end = p + (sectionLen - 5 - 4);
    while (p + 4 <= end) {
      const program = (payload[p] << 8) | payload[p+1];
      const pid = ((payload[p+2] & 0x1f) << 8) | payload[p+3];
      p += 4;
      if (program !== 0) { pmtPid = pid; }
    }
  }
  function parsePMT(payload: Uint8Array) {
    let p = 0;
    const pointer = payload[p++];
    p += pointer; if (p + 12 > payload.length) return;
    const tableId = payload[p++]; if (tableId !== 0x02) return;
    const sectionLen = ((payload[p] & 0x0f) << 8) | payload[p+1]; p += 2;
    p += 7; // program num + version + section nums + pcr pid
    const programInfoLen = ((payload[p] & 0x0f) << 8) | payload[p+1]; p += 2 + programInfoLen;
    const end = p + (sectionLen - 7 - 2 - programInfoLen - 4);
    while (p + 5 <= end) {
      const streamType = payload[p++];
      const elemPid = ((payload[p] & 0x1f) << 8) | payload[p+1]; p += 2;
      const esInfoLen = ((payload[p] & 0x0f) << 8) | payload[p+1]; p += 2 + esInfoLen;
      if (streamType === 0x1b /* H.264 */) vPid = elemPid;
      else if (streamType === 0x0f /* AAC */) aPid = elemPid;
    }
  }

  for (let off = 0; off + TS_PACKET_SIZE <= len; off += TS_PACKET_SIZE) {
    if (u8[off] !== SYNC_BYTE) continue;
    const pid = ((u8[off + 1] & 0x1f) << 8) | u8[off + 2];
    const payloadUnitStart = !!(u8[off + 1] & 0x40);
    const cc = u8[off + 3] & 0x0f;
    let payloadOff = off + 4;
    const afc = (u8[off + 3] >> 4) & 0x3;
    if (afc === 2 || afc === 3) {
      const afLen = u8[off + 4];
      // parse PCR if present
      if (afLen >= 7) {
        const flags = u8[off + 5];
        const pcrFlag = (flags & 0x10) !== 0;
        if (pcrFlag) {
          const p = off + 6;
          if (p + 6 <= off + 5 + afLen) {
            const b0 = u8[p], b1 = u8[p+1], b2 = u8[p+2], b3 = u8[p+3], b4 = u8[p+4], b5 = u8[p+5];
            const pcrBase = (b0 << 25) | (b1 << 17) | (b2 << 9) | (b3 << 1) | (b4 >> 7);
            const pcrExt = ((b4 & 0x01) << 8) | b5;
            const pcr27 = pcrBase * 300 + pcrExt;
            lastPcrUs = Math.round(pcr27 / 27);
          }
        }
      }
      payloadOff += 1 + afLen;
    }
    if (payloadOff > off + TS_PACKET_SIZE) continue;
    const payload = u8.subarray(payloadOff, off + TS_PACKET_SIZE);

    // continuity check
    if (ccMap[pid] !== undefined) {
      const expect = (ccMap[pid] + 1) & 0x0f;
      if (cc !== expect && afc !== 0 /* still check */) {
        // discontinuity: drop current assembly for this PID
        pesChunks[pid] = [];
      }
    }
    ccMap[pid] = cc;

    // PSI
    if (pid === 0 && payloadUnitStart) parsePAT(payload);
    if (pid === pmtPid && payloadUnitStart) parsePMT(payload);

    // ES
    if ((pid === vPid || pid === aPid) && payload.length) {
      if (payloadUnitStart) {
        // flush previous before starting new PES
        flushPes(pid);
        // parse header and start new assembly
  const info = readPtsFromPesHeader(payload);
        const start = info.headerLen;
        if (!pesChunks[pid]) pesChunks[pid] = [];
        if (start > 0 && start <= payload.length) pesChunks[pid].push(payload.subarray(start));
        if (info.pts !== undefined) pesPts[pid] = info.pts;
  if (info.dts !== undefined) (pesPts as any)[pid + 0x100000] = info.dts;
      } else {
        if (!pesChunks[pid]) pesChunks[pid] = [];
        pesChunks[pid].push(payload);
      }
    }
  }
  // flush any tail PES
  if (vPid >= 0) flushPes(vPid);
  if (aPid >= 0) flushPes(aPid);

  return samples;
}
