// 杈呭姪锛氫粠 ES 鏁版嵁涓彁鍙?NALU锛圓nnexB 鏍煎紡锛屾敮鎸?3/4 瀛楄妭璧峰鐮侊級
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

// 杈呭姪锛氬垽鏂?NALU 鏄惁涓?IDR锛坱ype 5锛?
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
    // 浠呭綋鍑虹幇 00 00 03 妯″紡鏃跺幓闄?0x03
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
import { decodePcrTimestampUs, estimateVideoFrameDurationUs } from './timing';
// MPEG-TS Demuxer (涓绘祦绋嬮鏋?
// 璐熻矗閬嶅巻 TS 鍖呫€佹牎楠屽悓姝ュ瓧鑺傘€佽В鏋?PID銆佹嫾鎺?PES銆佹彁鍙?PTS/DTS锛岃緭鍑洪煶瑙嗛 ES

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

// MPEG PTS/DTS is a 33-bit value. JavaScript bitwise operators coerce to a
// signed 32-bit integer, so assemble the high bits with safe arithmetic.
export function decodePesTimestamp(data: Uint8Array, offset: number): number {
  return (data[offset] & 0x0e) * 536870912
    + data[offset + 1] * 4194304
    + (data[offset + 2] & 0xfe) * 16384
    + data[offset + 3] * 128
    + (data[offset + 4] & 0xfe) / 2;
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
  // PTS unwrap锛堟寜 PID 鐙珛锛岄伩鍏嶉煶瑙嗛浜掔浉骞叉壈锛?
  const PTS_MOD = 0x200000000; // 2^33
  const wrapOffsetMap: Record<number, number> = {};
  const lastPtsModMap: Record<number, number> = {};
  // optional: track last PCR in us for potential alignment
  let lastPcrUs: number | undefined = undefined;
  let lastVideoPesPtsUs: number | undefined;
  let lastVideoPesAccessUnitCount = 1;
  let estimatedVideoFrameDurationUs = 33_333;
  let haveSentKey = false; // 浠呭湪瑙佸埌棣栦釜鍏抽敭甯у悗鍐嶅紑濮嬭緭鍑鸿棰戞牱鏈?
  function unwrapPts(pid: number, v: number): number {
    const lastPtsMod = lastPtsModMap[pid];
    let wrapOffset = wrapOffsetMap[pid] || 0;
    if (lastPtsMod !== undefined) {
      if (v < lastPtsMod && (lastPtsMod - v) > (PTS_MOD / 2)) {
        wrapOffset += PTS_MOD;
      } else if (v > lastPtsMod && (v - lastPtsMod) > (PTS_MOD / 2)) {
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
      pts = decodePesTimestamp(pay, 9);
    }
    if ((flags & 0x40) && hdrLen >= 10) {
      const b = 9 + 5;
      dts = decodePesTimestamp(pay, b);
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
      // 鎸?AUD(NAL type=9) 鎴?slice(棣栫墖) 鍒嗗抚锛岀‘淇濇瘡涓?EncodedVideoChunk 瀵瑰簲涓€涓?AU
      const groups: Uint8Array[][] = [];
      let cur: Uint8Array[] = [];
      let usedMarker = false;
      for (const n of nalus) {
        const t = n[0] & 0x1f;
        if (t === 9) {
          usedMarker = true;
          if (cur.length && cur.some(x => isSlice(x))) groups.push(cur);
          cur = [n];
        } else if (firstMbInSliceIsZero(n)) {
          usedMarker = true;
          if (cur.length && cur.some(x => isSlice(x))) {
            groups.push(cur);
            cur = [n];
          } else {
            cur.push(n);
          }
        } else {
          cur.push(n);
        }
      }
      if (cur.length) groups.push(cur);
  // 浠呬繚鐣欏寘鍚嚦灏戜竴涓?slice 鐨?AU锛岄伩鍏嶄粎鏈?SEI/AUD 鐨勬棤鏁堝抚
  const auListRaw = usedMarker && groups.length ? groups : [nalus];
  const auList = auListRaw.filter(g => g && g.length && g.some(n => isSlice(n)));
      const dts = (pesPts as any)[pid + 0x100000] as number | undefined;
  const basePtsUs = Math.round(ptsUnwrapped * 1000000 / 90000);
  const baseDtsUs = dts !== undefined ? Math.round(unwrapPts(pid, dts) * 1000000 / 90000) : undefined;
      estimatedVideoFrameDurationUs = estimateVideoFrameDurationUs(
        lastVideoPesPtsUs,
        basePtsUs,
        lastVideoPesAccessUnitCount,
        estimatedVideoFrameDurationUs
      );
      lastVideoPesPtsUs = basePtsUs;
      lastVideoPesAccessUnitCount = Math.max(1, auList.length);
      for (let accessUnitIndex = 0; accessUnitIndex < auList.length; accessUnitIndex += 1) {
        const g = auList[accessUnitIndex];
        if (!g || g.length === 0) continue;
        const isKey = g.some(n => isIDR(n));
        // 閲嶆柊缁勮 AnnexB锛堜负姣忎釜 NALU 鍔?4 瀛楄妭璧峰鐮侊級
        // 纭繚姣忎釜 AU 鍓嶉兘鏈?AUD锛圢AL type=9锛夛紝閮ㄥ垎瀹炵幇渚濊禆 AUD 鍒嗗抚
        const hasAud = g.some(n => (n[0] & 0x1f) === 9);
        const list: Uint8Array[] = hasAud ? g : [new Uint8Array([0x09, 0xF0]), ...g];
        const total = list.reduce((s, a) => s + 4 + a.length, 0);
        const buf = new Uint8Array(total);
        let p = 0;
        for (const a of list) { buf.set([0,0,0,1], p); p+=4; buf.set(a, p); p+=a.length; }
        if (buf.length >= 8) {
          if (!haveSentKey && !isKey) {
            // 棣栧叧閿抚闂ㄧ锛氬湪閬囧埌鍏抽敭甯т箣鍓嶏紝涓嶈緭鍑鸿棰戞牱鏈?
          } else {
            samples.push({
              kind: 'video',
              tsUs: basePtsUs + accessUnitIndex * estimatedVideoFrameDurationUs,
              dtsUs: baseDtsUs === undefined ? undefined : baseDtsUs + accessUnitIndex * estimatedVideoFrameDurationUs,
              durUs: estimatedVideoFrameDurationUs,
              key: isKey,
              data: buf.buffer,
              pcrUs: lastPcrUs
            });
            if (isKey && !haveSentKey) haveSentKey = true;
          }
        }
      }
    } else if (pid === aPid) {
      const raws = adtsToRaw(esData.slice().buffer);
      // 浼扮畻闊抽甯ф椂闀匡紙ADTS 涓€鑸?1024 鏍锋湰锛夊苟鎻愬彇鍙傛暟
      let durUs = 0;
      const info = getAdtsInfo(new Uint8Array(esData));
      if (info) durUs = Math.round(1024 * 1e6 / info.sampleRate);
      const asc = extractASC(esData.slice().buffer);
  const baseAudioUs = Math.round(ptsUnwrapped * 1000000 / 90000);
      for (let i = 0; i < raws.length; i++) {
        const raw = raws[i];
        // 灏嗛噰鏍风巼/澹伴亾鏁?ASC 闄勫甫鍦ㄦ牱鏈笂锛堜究浜庝富绾跨▼閰嶇疆 WebCodecs AudioDecoder锛?
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
            lastPcrUs = decodePcrTimestampUs(u8, p);
          }
        }
      }
      payloadOff += 1 + afLen;
    }
    if (payloadOff > off + TS_PACKET_SIZE) continue;
    const payload = u8.subarray(payloadOff, off + TS_PACKET_SIZE);

    // Continuity counters advance only on packets carrying payload (AFC 1/3).
    // Treating adaptation-only packets (AFC 2) as payload discontinuities
    // truncates AAC PES data and leaves only a few decodable frames per segment.
    const hasPayload = afc === 1 || afc === 3;
    if (hasPayload && ccMap[pid] !== undefined) {
      const expect = (ccMap[pid] + 1) & 0x0f;
      if (cc !== expect) {
        // discontinuity: drop current assembly for this PID
        pesChunks[pid] = [];
      }
    }
    if (hasPayload) ccMap[pid] = cc;

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

