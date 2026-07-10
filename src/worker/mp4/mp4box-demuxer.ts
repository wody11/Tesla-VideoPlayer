import { createFile, type Movie, type Sample } from 'mp4box';
import type { TeslaWorkerEvent } from '../worker-protocol';

type Post = (message: TeslaWorkerEvent, transfer?: Transferable[]) => void;

export interface Mp4DemuxSession {
  pull(count: number): void;
  stop(): void;
}

/**
 * Demuxes ISO-BMFF without a media element. MP4Box only parses containers;
 * compressed samples are still decoded by WebCodecs on the main thread.
 */
export function demuxMp4(buffer: ArrayBuffer, post: Post, startTime = 0): Mp4DemuxSession {
  const file = createFile();
  const pending: Array<{ kind: 'video' | 'audio'; sample: Sample }> = [];
  let credit = 0;
  let ready = false;
  let ended = false;
  let stopped = false;

  const pump = () => {
    if (!ready || stopped) return;
    while (credit > 0 && pending.length > 0) {
      const item = pending.shift()!;
      const sample = item.sample;
      if (!sample.data) continue;
      const data = sample.data.slice().buffer;
      const timestamp = Math.round((sample.cts / sample.timescale) * 1_000_000);
      const duration = Math.max(0, Math.round((sample.duration / sample.timescale) * 1_000_000));
      if (item.kind === 'video') {
        post({ type: 'video-sample', timestamp, duration, key: sample.is_sync, data }, [data]);
      } else {
        post({ type: 'audio-sample', timestamp, duration, data }, [data]);
      }
      credit -= 1;
    }
    if (ended && pending.length === 0) {
      ended = false;
      post({ type: 'stream-end' });
    }
  };

  file.onError = error => post({ type: 'error', message: `MP4 demux failed: ${String(error)}` });
  file.onSamples = (_id, kind, samples) => {
    for (const sample of samples) pending.push({ kind: kind as 'video' | 'audio', sample });
  };
  file.onReady = (info: Movie) => {
    try {
      const video = info.videoTracks[0];
      const audio = info.audioTracks[0];
      if (!video && !audio) throw new Error('MP4 contains no playable audio or video track.');

      post({
        type: 'media-info',
        duration: info.timescale ? info.duration / info.timescale : 0,
        videoCodec: video?.codec,
        audioCodec: audio?.codec
      });

      if (video) {
        const supported = /^(avc1|avc3|hvc1|hev1|av01|vp09)/i.test(video.codec);
        if (!supported) throw new Error(`Unsupported MP4 video codec: ${video.codec}`);
        const boxType = /^(avc1|avc3)/i.test(video.codec)
          ? 'avcC'
          : /^(hvc1|hev1)/i.test(video.codec)
            ? 'hvcC'
            : /^av01/i.test(video.codec) ? 'av1C' : undefined;
        const description = boxType ? findBoxPayload(buffer, boxType) : undefined;
        if (boxType && !description) throw new Error(`MP4 ${boxType} decoder configuration is missing.`);
        post({ type: 'video-config', codec: video.codec, description });
        file.setExtractionOptions(video.id, 'video', { nbSamples: 256 });
      }

      if (audio) {
        if (!/^mp4a\.40\./i.test(audio.codec)) {
          throw new Error(`Unsupported MP4 audio codec: ${audio.codec}; AAC is currently required.`);
        }
        const entry: any = file.getTrackById(audio.id)?.mdia?.minf?.stbl?.stsd?.entries?.[0];
        const description = findDescriptorData(entry?.esds?.esd, 0x05);
        if (!description?.byteLength) throw new Error('MP4 AAC AudioSpecificConfig is missing.');
        const asc = new Uint8Array(description).slice().buffer;
        post({
          type: 'audio-config',
          codec: audio.codec,
          description: asc,
          sampleRate: audio.audio?.sample_rate || 48000,
          numberOfChannels: audio.audio?.channel_count || 2
        }, [asc]);
        file.setExtractionOptions(audio.id, 'audio', { nbSamples: 512 });
      }

      if (startTime > 0) file.seek(startTime, true);
      file.start();
    } catch (error: any) {
      post({ type: 'error', message: String(error?.message || error) });
    }
  };

  const input = buffer as ArrayBuffer & { fileStart: number };
  input.fileStart = 0;
  file.appendBuffer(input);
  file.flush();
  // Extraction callbacks are synchronous during flush. Preserve per-track decode
  // order, then interleave tracks by DTS so audio and video reach the player together.
  pending.sort((a, b) => (a.sample.dts / a.sample.timescale) - (b.sample.dts / b.sample.timescale));
  ready = true;
  ended = true;
  pump();

  return {
    pull(count: number) {
      credit += Math.max(0, Math.min(2000, Math.floor(count) || 0));
      pump();
    },
    stop() {
      stopped = true;
      pending.length = 0;
      try { file.stop(); } catch {}
    }
  };
}

function findDescriptorData(descriptor: any, tag: number): Uint8Array | undefined {
  if (!descriptor) return undefined;
  if (descriptor.tag === tag && descriptor.data?.byteLength) return descriptor.data;
  for (const child of descriptor.descs || []) {
    const data = findDescriptorData(child, tag);
    if (data) return data;
  }
  return undefined;
}

function findBoxPayload(buffer: ArrayBuffer, type: string): ArrayBuffer | undefined {
  const bytes = new Uint8Array(buffer);
  for (let i = 4; i + 4 <= bytes.length; i++) {
    if (bytes[i] !== type.charCodeAt(0) || bytes[i + 1] !== type.charCodeAt(1)
      || bytes[i + 2] !== type.charCodeAt(2) || bytes[i + 3] !== type.charCodeAt(3)) continue;
    const start = i - 4;
    const size = new DataView(buffer, start, 4).getUint32(0);
    if (size >= 8 && start + size <= bytes.length) return buffer.slice(i + 4, start + size);
  }
  return undefined;
}
