// Minimal mp4 demuxer skeleton (recommend using mp4box.js in practice)
// Very small MP4 init parser to extract basic video/audio track info (avcC / esds)
// This is intentionally minimal and only supports common moov->trak->mdia->minf->stbl boxes
export function parseInit(arrayBuffer: ArrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const len = dv.byteLength;
  let offset = 0;

  function readUint32(off: number) { return dv.getUint32(off); }
  function readType(off: number) {
    return String.fromCharCode(
      dv.getUint8(off), dv.getUint8(off+1), dv.getUint8(off+2), dv.getUint8(off+3)
    );
  }

  const info: any = { video: null, audio: null };

  // parse mvhd if present to extract overall duration/timescale
  function parseMvhd(start: number, size: number) {
    try {
      const ver = dv.getUint8(start + 8);
      if (ver === 1) {
        const timescale = dv.getUint32(start + 20);
        // duration is 64-bit at offset 24
        const hi = dv.getUint32(start + 24);
        const lo = dv.getUint32(start + 28);
        const duration = (BigInt(hi) << 32n) | BigInt(lo);
        if (timescale) info.durationMs = Number(duration * 1000n / BigInt(timescale));
      } else {
        const timescale = dv.getUint32(start + 12);
        const duration = dv.getUint32(start + 16);
        if (timescale) info.durationMs = Math.round(duration * 1000 / timescale);
      }
    } catch (e) { /* ignore */ }
  }

  // helper to find child boxes in a range
  function findBoxes(start: number, end: number) {
    const boxes: Array<{ type: string; off: number; size: number }> = [];
    let o = start;
    while (o + 8 <= end) {
      const s = dv.getUint32(o);
      const t = String.fromCharCode(dv.getUint8(o+4), dv.getUint8(o+5), dv.getUint8(o+6), dv.getUint8(o+7));
      if (s <= 0) break;
      boxes.push({ type: t, off: o, size: s });
      o += s;
    }
    return boxes;
  }

  while (offset + 8 <= len) {
    const size = readUint32(offset);
    const type = readType(offset + 4);
    if (size === 0) break;
    const end = offset + size;

    if (type === 'moov' || type === 'trak' || type === 'mdia' || type === 'minf' || type === 'stbl' || type === 'stsd') {
      // descend into these boxes
    }

    // detect movie header
    if (type === 'mvhd') {
      parseMvhd(offset, size);
    }

    // look for 'avcC' or 'esds' boxes
    if (type === 'avc1' || type === 'mp4v' || type === 'encv') {
      // look for avcC inside this atom
      let sub = offset + 8;
      while (sub + 8 <= end) {
        const ssz = readUint32(sub);
        const stype = readType(sub + 4);
        if (stype === 'avcC') {
          const off = sub + 8;
          const slen = ssz - 8;
          info.video = info.video || {};
          info.video.avcC = new Uint8Array(arrayBuffer.slice(off, off + slen));
          // avcC lengthSize is at offset 4 (lower 2 bits)
          try { info.video.nalLengthSize = (info.video.avcC[4] & 0x03) + 1; } catch(e) { info.video.nalLengthSize = 4; }
          break;
        }
        if (ssz <= 0) break;
        sub += ssz;
      }
    }

  if (type === 'sinf' || type === 'mp4a' || type === 'enca') {
      // search for esds
      let sub = offset + 8;
      while (sub + 8 <= end) {
        const ssz = readUint32(sub);
        const stype = readType(sub + 4);
        if (stype === 'esds') {
          const off = sub + 8;
          const slen = ssz - 8;
          info.audio = info.audio || {};
          info.audio.esds = new Uint8Array(arrayBuffer.slice(off, off + slen));
          break;
        }
        if (ssz <= 0) break;
        sub += ssz;
      }
    }

    // direct avcC box
    if (type === 'avcC') {
      const off = offset + 8;
      const slen = size - 8;
      info.video = info.video || {};
      info.video.avcC = new Uint8Array(arrayBuffer.slice(off, off + slen));
    }

    // esds direct
    if (type === 'esds') {
      const off = offset + 8;
      const slen = size - 8;
      info.audio = info.audio || {};
      info.audio.esds = new Uint8Array(arrayBuffer.slice(off, off + slen));
    }

    offset = end;
  }

  return info;
}

// parseFragment: given an ArrayBuffer containing moof+mdat pairs, extract samples
export function parseFragment(arrayBuffer: ArrayBuffer, info: any) {
  const dv = new DataView(arrayBuffer);
  const len = dv.byteLength;
  let offset = 0;
  const samples: any[] = [];

  function readType(off: number){ return String.fromCharCode(dv.getUint8(off), dv.getUint8(off+1), dv.getUint8(off+2), dv.getUint8(off+3)); }
  function readUint32(off:number){ return dv.getUint32(off); }

  while (offset + 8 <= len) {
    const size = readUint32(offset);
    const type = readType(offset + 4);
    if (size <= 8) { offset += Math.max(8, size); continue; }
    const end = offset + size;

    if (type === 'moof') {
      // find following mdat
      let scan = end;
      while (scan + 8 <= len) {
        const s2 = readUint32(scan);
        const t2 = readType(scan + 4);
        if (t2 === 'mdat') break;
        scan += Math.max(8, s2);
      }
      const mdatOff = scan;
      const mdatSize = (mdatOff + 8 <= len) ? readUint32(mdatOff) : 0;
      const mdatDataOff = mdatOff + 8;

      // parse traf inside moof
      let moofPtr = offset + 8;
      while (moofPtr + 8 <= end) {
        const childSize = readUint32(moofPtr);
        const childType = readType(moofPtr + 4);
        if (childType === 'traf') {
          // parse tfhd, tfdt, trun
          const trafEnd = moofPtr + childSize;
          let trackId = null;
          let default_sample_duration = 0;
          let default_sample_size = 0;
          let baseMediaDecodeTime = 0n;
          // iterate children
          let tptr = moofPtr + 8;
          while (tptr + 8 <= trafEnd) {
            const tsz = readUint32(tptr);
            const ttype = readType(tptr + 4);
            if (ttype === 'tfhd') {
              const version = dv.getUint8(tptr + 8);
              const flags = dv.getUint8(tptr + 9) << 16 | dv.getUint8(tptr+10) << 8 | dv.getUint8(tptr+11);
              // track id at offset 12
              trackId = dv.getUint32(tptr + 12);
              // sample defaults may follow; skip to parse sample-duration/size if present in flags
              // flags bit 0x000008 (0x08) indicates default-base-is-moof? ignore
              // read optional fields based on flags: using spec bitmasks
              // For simplicity, try to read default_sample_duration/size at common offsets
              // naive approach: search for 'default_sample_duration' field by offset if tsz >= 28
              if (tsz >= 28) {
                // attempt to read default_sample_duration at offset 20
                try { default_sample_duration = dv.getUint32(tptr + 20); } catch(e){ default_sample_duration = 0; }
                try { default_sample_size = dv.getUint32(tptr + 24); } catch(e){ default_sample_size = 0; }
              }
            } else if (ttype === 'tfdt') {
              const version = dv.getUint8(tptr + 8);
              if (version === 1) {
                baseMediaDecodeTime = BigInt(dv.getUint32(tptr + 12)) << 32n | BigInt(dv.getUint32(tptr + 16));
              } else {
                baseMediaDecodeTime = BigInt(dv.getUint32(tptr + 12));
              }
            } else if (ttype === 'trun') {
              const version = dv.getUint8(tptr + 8);
              const flags = (dv.getUint8(tptr+9) << 16) | (dv.getUint8(tptr+10) << 8) | dv.getUint8(tptr+11);
              const sample_count = dv.getUint32(tptr + 12);
              let cursor = tptr + 16;
              let data_offset = 0;
              if (flags & 0x000001) { data_offset = dv.getInt32(cursor); cursor += 4; }
              if (flags & 0x000004) { cursor += 4; } // first_sample_flags
              // iterate samples
              let sampleOffsetInMdat = mdatDataOff + (data_offset > 0 ? data_offset - 8 : 0);
              // accumulate
              let durAcc = 0n;
              for (let i=0;i<sample_count;i++){
                let sample_duration = 0;
                let sample_size = 0;
                if (flags & 0x000100) { sample_duration = dv.getUint32(cursor); cursor += 4; } else sample_duration = default_sample_duration;
                if (flags & 0x000200) { sample_size = dv.getUint32(cursor); cursor += 4; } else sample_size = default_sample_size;
                if (flags & 0x000400) { cursor += 4; } // sample_flags
                if (flags & 0x000800) { cursor += 4; } // sample_composition_time_offset
                // slice sample bytes
                if (sample_size > 0) {
                  const sOff = sampleOffsetInMdat;
                  const sEnd = sOff + sample_size;
                  if (sEnd <= len) {
                    const data = arrayBuffer.slice(sOff, sEnd);
                    // compute pts in microseconds
                    const timescale = info && info.video && info.video.timescale ? info.video.timescale : 1000;
                    const ptsUs = Number((baseMediaDecodeTime + durAcc) * BigInt(1000000) / BigInt(timescale));
                    const durUs = Math.round(sample_duration * (1000000 / timescale));
                    // simple keyframe detection: check first NAL unit type if AVC
                    let key = false;
                    try{
                      const u8 = new Uint8Array(data);
                      // AVCC: first 4 bytes length then nal header
                      if (u8.length >= 5) {
                        const nalType = u8[4] & 0x1f;
                        if (nalType === 5) key = true;
                      }
                    }catch(e){}
                    samples.push({ kind: 'video', ts: ptsUs, dur: durUs, key, data });
                  }
                  sampleOffsetInMdat += sample_size;
                }
                durAcc += BigInt(sample_duration || 0);
              }
            }
            tptr += tsz;
          }
        }
        moofPtr += childSize;
      }
    }

    offset = end;
  }

  // If no moof-based samples found, try to parse moov/stbl (progressive MP4)
  if (!samples.length) {
    try {
      const more = parseMoovSamples(arrayBuffer, info);
      if (more && more.length) samples.push(...more);
    } catch (e) { /* ignore */ }
  }

  return samples;
}

// Minimal moov/stbl parser to extract sample sizes/offsets/timestamps for non-fragmented MP4
export function parseMoovSamples(arrayBuffer: ArrayBuffer, info: any) {
  const dv = new DataView(arrayBuffer);
  const len = dv.byteLength;
  let offset = 0;

  function readType(off:number){ return String.fromCharCode(dv.getUint8(off), dv.getUint8(off+1), dv.getUint8(off+2), dv.getUint8(off+3)); }
  function readUint32(off:number){ return dv.getUint32(off); }

  // find moov box
  let moovOff = -1, moovSize = 0;
  while (offset + 8 <= len) {
    const size = readUint32(offset);
    const type = readType(offset + 4);
    if (type === 'moov') { moovOff = offset; moovSize = size; break; }
    if (size <= 0) break;
    offset += size;
  }
  if (moovOff < 0) return [];

  // find video trak
  let trakOff = -1, trakSize = 0;
  let ptr = moovOff + 8;
  while (ptr + 8 <= moovOff + moovSize) {
    const sz = readUint32(ptr);
    const t = readType(ptr + 4);
    if (t === 'trak') { trakOff = ptr; trakSize = sz; break; }
    if (sz <= 0) break;
    ptr += sz;
  }
  if (trakOff < 0) return [];

  // find mdia/mdhd timescale and stbl
  let mdiaOff = -1, mdiaSize = 0;
  ptr = trakOff + 8;
  while (ptr + 8 <= trakOff + trakSize) {
    const sz = readUint32(ptr);
    const t = readType(ptr + 4);
    if (t === 'mdia') { mdiaOff = ptr; mdiaSize = sz; break; }
    if (sz <= 0) break;
    ptr += sz;
  }
  if (mdiaOff < 0) return [];

  // mdhd for timescale
  let timescale = 1000;
  ptr = mdiaOff + 8;
  while (ptr + 8 <= mdiaOff + mdiaSize) {
    const sz = readUint32(ptr);
    const t = readType(ptr + 4);
    if (t === 'mdhd') {
      const version = dv.getUint8(ptr + 8);
      if (version === 1) timescale = dv.getUint32(ptr + 12 + 8);
      else timescale = dv.getUint32(ptr + 12);
      break;
    }
    ptr += sz;
  }

  // find stbl
  let stblOff = -1, stblSize = 0;
  // traverse mdia->minf->stbl
  ptr = mdiaOff + 8;
  // find minf
  let minfOff = -1, minfSize = 0;
  while (ptr + 8 <= mdiaOff + mdiaSize) {
    const sz = readUint32(ptr);
    const t = readType(ptr + 4);
    if (t === 'minf') { minfOff = ptr; minfSize = sz; break; }
    ptr += sz;
  }
  if (minfOff < 0) return [];
  ptr = minfOff + 8;
  while (ptr + 8 <= minfOff + minfSize) {
    const sz = readUint32(ptr);
    const t = readType(ptr + 4);
    if (t === 'stbl') { stblOff = ptr; stblSize = sz; break; }
    ptr += sz;
  }
  if (stblOff < 0) return [];

  // read boxes inside stbl: stsd(avcC), stsz, stco/co64, stsc, stts, stss
  let avcC = null, nalLengthSize = 4;
  let sampleCount = 0; let sampleSizes: number[] = [];
  let chunkOffsets: number[] = [];
  let stsc: Array<{first: number, samples: number}> = [];
  let stts: Array<{count:number, delta:number}> = [];
  let syncSamples: Set<number> = new Set();

  ptr = stblOff + 8;
  while (ptr + 8 <= stblOff + stblSize) {
    const sz = readUint32(ptr);
    const t = readType(ptr + 4);
    if (t === 'stsd') {
      // inside stsd find avcC
      let p2 = ptr + 8 + 8; // skip version/flags and entry_count
      const end2 = ptr + sz;
      while (p2 + 8 <= end2) {
        const s2 = readUint32(p2);
        const ty2 = readType(p2 + 4);
        if (ty2 === 'avc1' || ty2 === 'avc3') {
          // search avcC inside
          let s3 = p2 + 8;
          while (s3 + 8 <= p2 + s2) {
            const ssz = readUint32(s3);
            const stype = readType(s3 + 4);
            if (stype === 'avcC') { avcC = new Uint8Array(arrayBuffer.slice(s3 + 8, s3 + ssz)); try { nalLengthSize = (avcC[4] & 0x03)+1; } catch(e){} break; }
            s3 += ssz;
          }
        }
        p2 += s2;
      }
    } else if (t === 'stsz') {
      const version = dv.getUint8(ptr + 8);
      const sample_size = dv.getUint32(ptr + 12);
      const count = dv.getUint32(ptr + 16);
      sampleCount = count;
      if (sample_size === 0) {
        // read table
        let p = ptr + 20;
        for (let i=0;i<count;i++){ sampleSizes.push(dv.getUint32(p)); p += 4; }
      } else {
        for (let i=0;i<count;i++) sampleSizes.push(sample_size);
      }
    } else if (t === 'stco') {
      const entry_count = dv.getUint32(ptr + 12);
      let p = ptr + 16;
      for (let i=0;i<entry_count;i++){ chunkOffsets.push(dv.getUint32(p)); p += 4; }
    } else if (t === 'co64') {
      const entry_count = dv.getUint32(ptr + 12);
      let p = ptr + 16;
      for (let i=0;i<entry_count;i++){ const hi = dv.getUint32(p); const lo = dv.getUint32(p+4); chunkOffsets.push(Number((BigInt(hi) << 32n) | BigInt(lo))); p += 8; }
    } else if (t === 'stsc') {
      const entry_count = dv.getUint32(ptr + 12);
      let p = ptr + 16;
      for (let i=0;i<entry_count;i++){ const first = dv.getUint32(p); const samples = dv.getUint32(p+4); /*const desc = dv.getUint32(p+8)*/; stsc.push({first, samples}); p += 12; }
    } else if (t === 'stts') {
      const entry_count = dv.getUint32(ptr + 12);
      let p = ptr + 16;
      for (let i=0;i<entry_count;i++){ const c = dv.getUint32(p); const d = dv.getUint32(p+4); stts.push({count:c, delta:d}); p += 8; }
    } else if (t === 'stss') {
      const entry_count = dv.getUint32(ptr + 12);
      let p = ptr + 16; for (let i=0;i<entry_count;i++){ syncSamples.add(dv.getUint32(p)); p += 4; }
    }
    ptr += sz;
  }

  if (!sampleCount || !sampleSizes.length || !chunkOffsets.length) return [];

  // expand stsc into per-chunk sample counts
  const chunkSampleCounts: number[] = [];
  for (let i=0;i<chunkOffsets.length;i++) chunkSampleCounts.push(0);
  for (let i=0;i<stsc.length;i++){
    const start = stsc[i].first - 1;
    const end = (i+1 < stsc.length) ? stsc[i+1].first - 2 : chunkSampleCounts.length - 1;
    for (let c = start; c <= end; c++) chunkSampleCounts[c] = stsc[i].samples;
  }

  // now build sample offsets by walking chunks
  const samples: any[] = [];
  let sampleIndex = 0;
  for (let ci=0; ci<chunkOffsets.length; ci++){
    const chunkOff = chunkOffsets[ci];
    const samplesInChunk = chunkSampleCounts[ci] || 0;
    let cursor = chunkOff;
    for (let s=0; s<samplesInChunk; s++){
      if (sampleIndex >= sampleSizes.length) break;
      const sz = sampleSizes[sampleIndex];
      const sOff = cursor;
      const sEnd = cursor + sz;
      if (sEnd <= len) {
        const data = arrayBuffer.slice(sOff, sEnd);
        // compute pts from stts by sampleIndex
        let remaining = sampleIndex; let pts = 0n;
        for (const e of stts){ const take = Math.min(remaining, e.count); pts += BigInt(take) * BigInt(e.delta); remaining -= take; if (remaining <= 0) break; }
        // fallback simple increment
        const ptsUs = Number(pts * 1000000n / BigInt(timescale));
        const durUs = Math.round((stts.length ? stts[0].delta : 0) * (1000000 / timescale));
        const key = syncSamples.size ? syncSamples.has(sampleIndex+1) : false;
        samples.push({ kind: 'video', ts: ptsUs, dur: durUs, key, data });
      }
      cursor += sz; sampleIndex++;
    }
  }

  return samples;
}

// Extract SPS/PPS NAL units from avcC box
export function extractSpsPpsFromAvcC(avcC: Uint8Array) {
  const out: { sps: ArrayBuffer[]; pps: ArrayBuffer[]; nalLengthSize: number } = { sps: [], pps: [], nalLengthSize: 4 };
  if (!avcC || avcC.length < 7) return out;
  try {
    const nalLen = (avcC[4] & 0x03) + 1;
    out.nalLengthSize = nalLen;
    const spsCount = avcC[5] & 0x1f;
    let off = 6;
    for (let i = 0; i < spsCount; i++) {
      const sl = (avcC[off] << 8) | avcC[off + 1]; off += 2;
      out.sps.push(avcC.slice(off, off + sl).buffer);
      off += sl;
    }
    const ppsCount = avcC[off]; off += 1;
    for (let i = 0; i < ppsCount; i++) {
      const pl = (avcC[off] << 8) | avcC[off + 1]; off += 2;
      out.pps.push(avcC.slice(off, off + pl).buffer);
      off += pl;
    }
  } catch (e) { /* ignore */ }
  return out;
}

// Convert AVCC formatted sample (length-prefixed NALs) to AnnexB (startcode prefixed)
export function avccToAnnexB(buf: ArrayBuffer, nalLengthSize = 4) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const outParts: Uint8Array[] = [];
  let o = 0;
  while (o + nalLengthSize <= u8.length) {
    let nalLen = 0;
    for (let i = 0; i < nalLengthSize; i++) { nalLen = (nalLen << 8) | u8[o + i]; }
    o += nalLengthSize;
    if (nalLen <= 0 || o + nalLen > u8.length) break;
    // startcode 0x00000001
    outParts.push(new Uint8Array([0x00,0x00,0x00,0x01]));
    outParts.push(u8.subarray(o, o + nalLen));
    o += nalLen;
  }
  // concat
  const total = outParts.reduce((s, p) => s + p.length, 0);
  const res = new Uint8Array(total);
  let ptr = 0; for (const p of outParts) { res.set(p, ptr); ptr += p.length; }
  return res.buffer;
}
