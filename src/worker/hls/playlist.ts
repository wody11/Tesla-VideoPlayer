// HLS m3u8 解析工具
// 负责解析 EXTINF、分片 URL、时长等

export interface HLSSegment {
  uri: string;        // 绝对 URL
  duration: number;   // 秒
  seq: number;        // 媒体序列号
  discontinuity?: boolean; // 是否在该分片前存在 DISCONTINUITY
}
export interface HLSKeyInfo {
  method: 'AES-128' | 'SAMPLE-AES' | 'NONE';
  uri?: string;       // 密钥 URL
  ivHex?: string;     // 可选 IV（十六进制 0x...）
}
export interface HLSPlaylistParsed {
  segments: HLSSegment[];
  key?: HLSKeyInfo;   // 当前 key（简化：只取最后一次声明）
  mediaSequence: number;
  targetDuration?: number; // 目标分片时长（秒）
  endList?: boolean;       // 是否含有 EXT-X-ENDLIST
  live?: boolean;          // 是否直播（没有 ENDLIST）
  playlistType?: 'VOD' | 'EVENT';
}

export function parseM3U8(text: string, base?: string): HLSPlaylistParsed {
  const lines = text.split(/\r?\n/);
  const segs: HLSSegment[] = [];
  let duration = 0;
  let seq = 0;
  let mediaSequence = 0;
  let key: HLSKeyInfo | undefined;
  let sawDiscontinuity = false;
  let targetDuration: number | undefined;
  let endList = false;
  let playlistType: 'VOD' | 'EVENT' | undefined;
  for (const L0 of lines) {
    const line = L0.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      const t = (line.split(':')[1] || '').trim().toUpperCase();
      if (t === 'VOD' || t === 'EVENT') playlistType = t as any;
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(line.split(':')[1] || '0', 10) || 0;
      seq = mediaSequence;
      continue;
    }
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      const v = parseFloat(line.split(':')[1] || '0');
      if (!Number.isNaN(v) && v > 0) targetDuration = v;
      continue;
    }
    if (line.startsWith('#EXT-X-ENDLIST')) { endList = true; continue; }
    if (line.startsWith('#EXT-X-KEY:')) {
      // 仅处理 AES-128
      const attrs = Object.fromEntries(line.replace('#EXT-X-KEY:', '').split(',').map(kv => {
        const [k, v] = kv.split('=');
        return [k.trim(), (v||'').replace(/^"|"$/g, '')];
      }));
      const method = (attrs['METHOD'] || 'NONE') as any;
      if (method === 'AES-128') {
        key = { method: 'AES-128', uri: attrs['URI'], ivHex: attrs['IV'] };
      } else if (method === 'NONE') {
        key = { method: 'NONE' } as any;
      } else {
        key = { method: 'SAMPLE-AES', uri: attrs['URI'], ivHex: attrs['IV'] };
      }
      continue;
    }
    if (line.startsWith('#EXT-X-DISCONTINUITY')) { sawDiscontinuity = true; continue; }
    if (line.startsWith('#EXTINF:')) {
      duration = parseFloat(line.slice(8).split(',')[0]);
      continue;
    }
    if (!line.startsWith('#')) {
      const abs = base ? new URL(line, base).href : line;
      segs.push({ uri: abs, duration, seq, discontinuity: sawDiscontinuity || undefined });
      seq++;
      duration = 0;
      sawDiscontinuity = false;
    }
  }
  return { segments: segs, key, mediaSequence, targetDuration, endList, live: !endList, playlistType };
}
// HLS playlist parser (very small helper)
export function parseMaster(text: string, base: string) {
  const lines = text.split(/\r?\n/);
  const out: any[] = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (L.startsWith('#EXT-X-STREAM-INF')) {
      let url = '';
      for (let j = i + 1; j < lines.length; j++) {
        const ln = lines[j].trim(); if (!ln || ln.startsWith('#')) continue; url = new URL(ln, base).href; i = j; break;
      }
      out.push({ url });
    }
  }
  return out;
}

// 将 VOD 内的时间（毫秒）映射到序号（媒体序号），返回应当从哪个 seq 开始拉取
export function timeToSeq(segments: HLSSegment[], mediaSequence: number, timeMs: number): number {
  if (!Array.isArray(segments) || segments.length === 0) return mediaSequence;
  if (!Number.isFinite(timeMs) || timeMs <= 0) return mediaSequence;
  let accMs = 0;
  let chosen = mediaSequence;
  for (const s of segments) {
    const durMs = Math.max(0, (s.duration || 0) * 1000);
    if (accMs + durMs > timeMs) { chosen = s.seq; break; }
    accMs += durMs;
    chosen = s.seq;
  }
  return chosen;
}
