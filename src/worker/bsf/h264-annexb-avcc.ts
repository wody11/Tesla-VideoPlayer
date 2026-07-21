// H.264 AnnexB <-> AVCC 转换工具
// 负责 NALU 格式转换，提取 SPS/PPS，构造 avcC

export function annexBToAvcc(buffer: ArrayBuffer): ArrayBuffer {
  const nalus = splitAnnexBNalus(new Uint8Array(buffer));
  const total = nalus.reduce((sum, nalu) => sum + 4 + nalu.byteLength, 0);
  const output = new Uint8Array(total);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const nalu of nalus) {
    view.setUint32(offset, nalu.byteLength);
    offset += 4;
    output.set(nalu, offset);
    offset += nalu.byteLength;
  }
  return output.buffer;
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
  const sps: ArrayBuffer[] = [];
  const pps: ArrayBuffer[] = [];
  for (const nalu of splitAnnexBNalus(new Uint8Array(buffer))) {
    const nalType = nalu[0] & 0x1f;
    if (nalType === 7) sps.push(nalu.slice().buffer);
    else if (nalType === 8) pps.push(nalu.slice().buffer);
  }
  return { sps, pps };
}

function splitAnnexBNalus(bytes: Uint8Array): Uint8Array[] {
  const nalus: Uint8Array[] = [];
  const startCodeLength = (offset: number): number => {
    if (offset + 3 <= bytes.length && bytes[offset] === 0 && bytes[offset + 1] === 0 && bytes[offset + 2] === 1) return 3;
    if (offset + 4 <= bytes.length && bytes[offset] === 0 && bytes[offset + 1] === 0 && bytes[offset + 2] === 0 && bytes[offset + 3] === 1) return 4;
    return 0;
  };

  let offset = 0;
  while (offset < bytes.length) {
    while (offset < bytes.length && startCodeLength(offset) === 0) offset += 1;
    const prefix = startCodeLength(offset);
    if (!prefix) break;
    const start = offset + prefix;
    offset = start;
    while (offset < bytes.length && startCodeLength(offset) === 0) offset += 1;
    if (offset > start) nalus.push(bytes.subarray(start, offset));
  }
  return nalus;
}

// Build an AVCDecoderConfigurationRecord (avcC payload) from SPS/PPS.
export function buildAVCCDesc(sps: Uint8Array, pps: Uint8Array) {
  const arr = new Uint8Array(7 + 2 + sps.length + 1 + 2 + pps.length);
  let o = 0; arr[o++]=1; arr[o++]=sps[1]; arr[o++]=sps[2]; arr[o++]=sps[3]; arr[o++]=0xff; arr[o++]=0xe1; arr[o++]=(sps.length>>8)&0xff; arr[o++]=sps.length&0xff; arr.set(sps,o); o+=sps.length; arr[o++]=1; arr[o++]=(pps.length>>8)&0xff; arr[o++]=pps.length&0xff; arr.set(pps,o);
  return arr;
}
