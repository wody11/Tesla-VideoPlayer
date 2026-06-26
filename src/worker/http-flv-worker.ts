import type { TeslaWorkerCommand, TeslaWorkerEvent } from './worker-protocol';
import { parseM3U8, parseMaster } from './hls/playlist';
import { demuxTS, TSSample } from './ts/demux-ts';
import { extractSpsPps } from './bsf/h264-annexb-avcc';

// HTTP-FLV demux worker. TODO: add WS-FLV once the HTTP-FLV path is stable.
let aborter: AbortController | null = null;
let paused = false;
let videoTagCount = 0;
let audioTagCount = 0;
let hlsSeqCount = 0;

function post(message: TeslaWorkerEvent, transfer?: Transferable[]): void {
  (self as any).postMessage(message, transfer || []);
}

function readU24(u8: Uint8Array, offset: number): number {
  return (u8[offset] << 16) | (u8[offset + 1] << 8) | u8[offset + 2];
}

function readS24(u8: Uint8Array, offset: number): number {
  const value = readU24(u8, offset);
  return value & 0x800000 ? value - 0x1000000 : value;
}

function avcCodecFromConfig(record: Uint8Array): string {
  if (record.length >= 4) {
    return `avc1.${hex(record[1])}${hex(record[2])}${hex(record[3])}`;
  }
  return 'avc1.42E01E';
}

function hex(value: number): string {
  return (value & 0xff).toString(16).padStart(2, '0').toUpperCase();
}

function parseAacConfig(asc: Uint8Array): { codec: string; sampleRate: number; channels: number } {
  const sampleRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const objectType = (asc[0] >> 3) & 0x1f;
  const sampleRateIndex = ((asc[0] & 0x07) << 1) | ((asc[1] >> 7) & 0x01);
  const channels = (asc[1] >> 3) & 0x0f;
  return {
    codec: `mp4a.40.${objectType || 2}`,
    sampleRate: sampleRates[sampleRateIndex] || 48000,
    channels: channels || 2
  };
}

function avcCodecFromSps(sps: Uint8Array): string {
  if (sps.length >= 4) return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
  return 'avc1.42E01E';
}

class FlvParser {
  private buffer = new Uint8Array(0);
  private headerDone = false;

  push(chunk: Uint8Array): void {
    const next = new Uint8Array(this.buffer.length + chunk.length);
    next.set(this.buffer, 0);
    next.set(chunk, this.buffer.length);
    this.buffer = next;
    this.parse();
  }

  private parse(): void {
    let offset = 0;
    if (!this.headerDone) {
      if (this.buffer.length < 13) return;
      if (this.buffer[0] !== 0x46 || this.buffer[1] !== 0x4c || this.buffer[2] !== 0x56) {
        throw new Error('Invalid FLV signature.');
      }
      const headerSize = (this.buffer[5] << 24) | (this.buffer[6] << 16) | (this.buffer[7] << 8) | this.buffer[8];
      offset = headerSize + 4;
      this.headerDone = true;
    }

    while (this.buffer.length - offset >= 15) {
      const tagType = this.buffer[offset];
      const dataSize = readU24(this.buffer, offset + 1);
      const timestampMs = readU24(this.buffer, offset + 4) | (this.buffer[offset + 7] << 24);
      const tagStart = offset + 11;
      const tagEnd = tagStart + dataSize;
      const nextOffset = tagEnd + 4;
      if (this.buffer.length < nextOffset) break;

      const payload = this.buffer.subarray(tagStart, tagEnd);
      if (tagType === 9) this.parseVideo(payload, timestampMs);
      else if (tagType === 8) this.parseAudio(payload, timestampMs);
      offset = nextOffset;
    }

    if (offset > 0) this.buffer = this.buffer.slice(offset);
  }

  private parseVideo(payload: Uint8Array, timestampMs: number): void {
    if (payload.length < 5) return;
    videoTagCount += 1;
    const frameType = payload[0] >> 4;
    const codecId = payload[0] & 0x0f;
    if (codecId !== 7) {
      post({ type: 'error', message: `Unsupported FLV video codec ${codecId}; only H.264/AVC is implemented.` });
      return;
    }

    const packetType = payload[1];
    const compositionMs = readS24(payload, 2);
    if (packetType === 0) {
      const description = payload.slice(5).buffer;
      post({ type: 'video-config', codec: avcCodecFromConfig(new Uint8Array(description)), description }, [description]);
      return;
    }
    if (packetType !== 1) return;

    const data = payload.slice(5).buffer;
    const timestamp = (timestampMs + compositionMs) * 1000;
    post({ type: 'video-sample', timestamp, key: frameType === 1, data }, [data]);
    post({ type: 'stats', videoTagCount, audioTagCount });
  }

  private parseAudio(payload: Uint8Array, timestampMs: number): void {
    if (payload.length < 2) return;
    audioTagCount += 1;
    const soundFormat = payload[0] >> 4;
    if (soundFormat !== 10) {
      post({ type: 'error', message: `Unsupported FLV audio codec ${soundFormat}; only AAC is implemented.` });
      return;
    }

    const packetType = payload[1];
    if (packetType === 0) {
      const description = payload.slice(2).buffer;
      const info = parseAacConfig(new Uint8Array(description));
      post({
        type: 'audio-config',
        codec: info.codec,
        description,
        sampleRate: info.sampleRate,
        numberOfChannels: info.channels
      }, [description]);
      return;
    }
    if (packetType !== 1) return;

    const data = payload.slice(2).buffer;
    post({ type: 'audio-sample', timestamp: timestampMs * 1000, data }, [data]);
    post({ type: 'stats', videoTagCount, audioTagCount });
  }
}

async function openHttpFlv(url: string): Promise<void> {
  aborter?.abort();
  aborter = new AbortController();
  paused = false;
  videoTagCount = 0;
  audioTagCount = 0;
  const parser = new FlvParser();

  try {
    const response = await fetch(url, { signal: aborter.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    if (!response.body) throw new Error('ReadableStream is not available on fetch response.');
    post({ type: 'stream-open' });
    const reader = response.body.getReader();
    while (true) {
      if (paused) {
        await new Promise(resolve => setTimeout(resolve, 30));
        continue;
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value) parser.push(value);
    }
    post({ type: 'stream-end' });
  } catch (error: any) {
    if (error?.name !== 'AbortError') post({ type: 'error', message: String(error?.message || error) });
  }
}

async function openHls(url: string, options: { liveStartSegmentCount?: number; liveSegmentBatch?: number } = {}): Promise<void> {
  aborter?.abort();
  aborter = new AbortController();
  paused = false;
  videoTagCount = 0;
  audioTagCount = 0;
  hlsSeqCount = 0;
  let mediaUrl = url;
  let lastSeq = -1;
  let videoConfigured = false;
  let audioConfigSignature = '';

  try {
    const firstText = await fetchText(mediaUrl);
    if (/EXT-X-STREAM-INF/i.test(firstText)) {
      const variants = parseMaster(firstText, mediaUrl);
      if (!variants.length) throw new Error('HLS master playlist has no playable variants.');
      mediaUrl = variants[0].url;
      post({ type: 'log', message: `HLS master playlist resolved to ${mediaUrl}` });
    }
    post({ type: 'stream-open' });

    while (!aborter?.signal.aborted) {
      if (paused) {
        await sleep(30);
        continue;
      }

      const text = mediaUrl === url && !/EXT-X-STREAM-INF/i.test(firstText) && lastSeq < 0
        ? firstText
        : await fetchText(mediaUrl);
      const playlist = parseM3U8(text, mediaUrl);
      if (playlist.key && playlist.key.method && playlist.key.method !== 'NONE') {
        throw new Error(`HLS encryption ${playlist.key.method} is not supported in standalone mode yet. TODO: add AES-128/SAMPLE-AES handling.`);
      }
      const candidates = playlist.segments.filter(segment => segment.seq > lastSeq);
      const liveStartSegmentCount = Math.max(1, Math.min(3, options.liveStartSegmentCount || 1));
      const liveSegmentBatch = Math.max(1, Math.min(3, options.liveSegmentBatch || 1));
      const segments = lastSeq < 0 && playlist.live ? candidates.slice(-liveStartSegmentCount) : candidates.slice(0, liveSegmentBatch);
      for (const segment of segments) {
        if (aborter?.signal.aborted) break;
        while (paused && !aborter?.signal.aborted) await sleep(30);
        const response = await fetchWithRetry(segment.uri, 'HLS segment');
        const samples = demuxTS(await response.arrayBuffer())
          .filter(sample => Number.isFinite(sample.tsUs) && sample.tsUs > 0);
        lastSeq = segment.seq;
        hlsSeqCount += 1;

        if (!videoConfigured) {
          const firstVideo = samples.find(sample => sample.kind === 'video');
          if (firstVideo) {
            const params = extractSpsPps(firstVideo.data);
            const sps = params.sps[0] ? new Uint8Array(params.sps[0]) : null;
            post({ type: 'video-config', codec: sps ? avcCodecFromSps(sps) : 'avc1.42E01E', annexb: true });
            videoConfigured = true;
          }
        }
        if (!audioConfigSignature) {
          const firstAudio = samples.find(sample => sample.kind === 'audio' && sample.asc && sample.asc.byteLength > 0);
          if (firstAudio) {
            const asc = (firstAudio.asc || new ArrayBuffer(0)).slice(0);
            audioConfigSignature = `${firstAudio.sr || 48000}/${firstAudio.ch || 2}/${new Uint8Array(asc).join('.')}`;
            post({
              type: 'audio-config',
              codec: 'mp4a.40.2',
              description: asc,
              sampleRate: firstAudio.sr || 48000,
              numberOfChannels: firstAudio.ch || 2
            });
          }
        }

        for (let i = 0; i < samples.length; i++) {
          const sample = samples[i];
          if (sample.kind === 'video') {
            videoTagCount += 1;
            postVideoSample(sample);
          } else {
            audioTagCount += 1;
            const asc = sample.asc || new ArrayBuffer(0);
            const sig = `${sample.sr || 48000}/${sample.ch || 2}/${new Uint8Array(asc).join('.')}`;
            if (asc.byteLength > 0 && sig !== audioConfigSignature) {
              audioConfigSignature = sig;
              const description = asc.slice(0);
              post({
                type: 'audio-config',
                codec: 'mp4a.40.2',
                description,
                sampleRate: sample.sr || 48000,
                numberOfChannels: sample.ch || 2
              });
            }
            postAudioSample(sample);
          }
          post({ type: 'stats', videoTagCount, audioTagCount });
        }
      }

      if (playlist.endList) break;
      const waitMs = Math.max(300, Math.min(2000, Math.round((playlist.targetDuration || 4) * 500)));
      await sleep(waitMs);
    }
    post({ type: 'stream-end' });
  } catch (error: any) {
    if (error?.name !== 'AbortError') post({ type: 'error', message: String(error?.message || error) });
  }
}

async function fetchText(url: string): Promise<string> {
  const response = await fetchWithRetry(url, 'HLS playlist');
  return response.text();
}

async function fetchWithRetry(url: string, label: string): Promise<Response> {
  let lastStatus = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(url, { signal: aborter?.signal, cache: 'no-store' });
      if (response.ok) return response;
      lastStatus = `HTTP ${response.status}`;
    } catch (error: any) {
      if (error?.name === 'AbortError') throw error;
      lastStatus = String(error?.message || error);
    }
    post({ type: 'log', message: `${label} retry ${attempt + 1}/5: ${lastStatus}` });
    await sleep(300 + attempt * 300);
  }
  throw new Error(`${label} ${lastStatus}: ${url}`);
}

function postVideoSample(sample: TSSample): void {
  const data = sample.data;
  post({
    type: 'video-sample',
    timestamp: sample.tsUs,
    duration: sample.durUs || undefined,
    key: sample.key,
    data
  }, [data]);
}

function postAudioSample(sample: TSSample): void {
  const data = sample.data;
  post({
    type: 'audio-sample',
    timestamp: sample.tsUs,
    duration: sample.durUs || undefined,
    data
  }, [data]);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

self.addEventListener('message', (event: MessageEvent<TeslaWorkerCommand>) => {
  const message = event.data;
  if (message.type === 'open-http-flv') openHttpFlv(message.url);
  else if (message.type === 'open-hls') openHls(message.url, message);
  else if (message.type === 'pause') paused = true;
  else if (message.type === 'resume') paused = false;
  else if (message.type === 'stop') aborter?.abort();
});
