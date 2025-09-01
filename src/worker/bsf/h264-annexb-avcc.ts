// H.264 AnnexB <-> AVCC 转换工具
// 负责 NALU 格式转换，提取 SPS/PPS，构造 avcC

export function annexBToAvcc(buffer: ArrayBuffer): ArrayBuffer {
  // TODO: AnnexB 转 AVCC
  return buffer;
}

// AVCC 转 AnnexB（支持 ArrayBuffer/Uint8Array 入参）
export function avccToAnnexB(input: ArrayBuffer | Uint8Array, nalLengthSize = 4): ArrayBuffer {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const out: Uint8Array[] = [];
  let o = 0;
  while (o + nalLengthSize <= u8.length) {
    let n = 0;
    for (let i = 0; i < nalLengthSize; i++) n = (n << 8) | u8[o + i];
    o += nalLengthSize;
    if (n <= 0 || o + n > u8.length) break;
    out.push(u8.subarray(o, o + n));
    o += n;
  }
  const size = out.reduce((s, a) => s + 4 + a.length, 0);
  const res = new Uint8Array(size);
  let p = 0;
  for (const a of out) {
    res.set([0, 0, 0, 1], p);
    p += 4;
    res.set(a, p);
    p += a.length;
  }
  return res.buffer;
}

export function extractSpsPps(buffer: ArrayBuffer): { sps: ArrayBuffer[]; pps: ArrayBuffer[] } {
  const u8 = new Uint8Array(buffer);
  const sps: ArrayBuffer[] = [];
  const pps: ArrayBuffer[] = [];
  const len = u8.length;
  function startCodeLen(pos: number): number {
    if (pos + 3 < len && u8[pos] === 0 && u8[pos+1] === 0) {
      if (u8[pos+2] === 1) return 3;
      if (pos + 4 < len && u8[pos+2] === 0 && u8[pos+3] === 1) return 4;
    }
    return 0;
  }
  let i = 0;
  while (i < len) {
    while (i < len && startCodeLen(i) === 0) i++;
    const sc = startCodeLen(i);
    if (!sc) break;
    const start = i + sc;
    i = start;
    while (i < len && startCodeLen(i) === 0) i++;
    const end = i;
    if (end > start) {
      const nalu = u8.subarray(start, end);
      const nalType = nalu[0] & 0x1f;
      if (nalType === 7) sps.push(nalu.slice().buffer);
      else if (nalType === 8) pps.push(nalu.slice().buffer);
    }
  }
  return { sps, pps };
}
// H.264 AnnexB <-> AVCC helpers (skeleton)
// 已合并到 avccToAnnexB(input, nalLengthSize)
export function buildAVCCDesc(sps: Uint8Array, pps: Uint8Array) {
  const arr = new Uint8Array(7 + 2 + sps.length + 1 + 2 + pps.length);
  let o = 0; arr[o++]=1; arr[o++]=sps[1]; arr[o++]=sps[2]; arr[o++]=sps[3]; arr[o++]=0xff; arr[o++]=0xe1; arr[o++]=(sps.length>>8)&0xff; arr[o++]=sps.length&0xff; arr.set(sps,o); o+=sps.length; arr[o++]=1; arr[o++]=(pps.length>>8)&0xff; arr[o++]=pps.length&0xff; arr.set(pps,o);
  return arr;
}
