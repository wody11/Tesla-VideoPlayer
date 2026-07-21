import { createFile, DataStream, type Movie, type Sample } from 'mp4box';
import type { TeslaWorkerEvent } from '../worker-protocol';

type Post = (message: TeslaWorkerEvent, transfer?: Transferable[]) => void;

type PendingSample = { kind: 'video' | 'audio'; sample: Sample };

export interface Mp4DemuxSession {
  append(buffer: ArrayBuffer, fileStart: number, last?: boolean): number;
  finish(): void;
  pull(count: number): void;
  bufferedSamples(): number;
  stop(): void;
}

/**
 * Incremental ISO-BMFF demuxing. Range chunks are appended directly to MP4Box;
 * the worker never assembles a second full-file ArrayBuffer.
 */
export function createMp4DemuxSession(post: Post, startTime = 0): Mp4DemuxSession {
  const file = createFile();
  const pending: PendingSample[] = [];
  let credit = 0;
  let ready = false;
  let inputEnded = false;
  let endPosted = false;
  let stopped = false;
  let videoSampleCount = 0;
  let audioSampleCount = 0;

  const sortPending = () => {
    pending.sort((a, b) => (a.sample.dts / a.sample.timescale) - (b.sample.dts / b.sample.timescale));
  };

  const maybePostEnd = () => {
    if (!endPosted && ready && inputEnded && pending.length === 0) {
      endPosted = true;
      post({ type: 'stream-end' });
    }
  };

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
        videoSampleCount += 1;
        post({ type: 'video-sample', timestamp, duration, key: sample.is_sync, data }, [data]);
      } else {
        audioSampleCount += 1;
        post({ type: 'audio-sample', timestamp, duration, data }, [data]);
      }
      if ((videoSampleCount + audioSampleCount) % 16 === 0 || pending.length === 0) {
        post({ type: 'stats', videoTagCount: videoSampleCount, audioTagCount: audioSampleCount });
      }
      credit -= 1;
      try { file.releaseUsedSamples(sample.track_id, sample.number + 1); } catch {}
    }
    maybePostEnd();
  };

  file.onError = error => post({ type: 'error', message: `MP4 demux failed: ${String(error)}` });
  file.onSamples = (_id, kind, samples) => {
    for (const sample of samples) pending.push({ kind: kind as 'video' | 'audio', sample });
    sortPending();
    pump();
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
        const entry: any = file.getTrackById(video.id)?.mdia?.minf?.stbl?.stsd?.entries?.[0];
        const requiresConfiguration = /^(avc1|avc3|hvc1|hev1|av01)/i.test(video.codec);
        const configBox = /^(avc1|avc3)/i.test(video.codec)
          ? entry?.avcC
          : /^(hvc1|hev1)/i.test(video.codec)
            ? entry?.hvcC
            : /^av01/i.test(video.codec) ? entry?.av1C : undefined;
        const description = configBox ? serializeConfigurationBox(configBox) : undefined;
        if (requiresConfiguration && !description?.byteLength) {
          throw new Error(`MP4 decoder configuration is missing for ${video.codec}.`);
        }
        post({ type: 'video-config', codec: video.codec, description });
        file.setExtractionOptions(video.id, 'video', { nbSamples: 48 });
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
        file.setExtractionOptions(audio.id, 'audio', { nbSamples: 96 });
      }

      ready = true;
      if (startTime > 0) file.seek(startTime, true);
      file.start();
      pump();
    } catch (error: any) {
      post({ type: 'error', message: String(error?.message || error) });
    }
  };

  return {
    append(buffer: ArrayBuffer, fileStart: number, last = false): number {
      if (stopped) return fileStart;
      const input = buffer as ArrayBuffer & { fileStart: number };
      input.fileStart = fileStart;
      return file.appendBuffer(input, last);
    },
    finish(): void {
      if (stopped || inputEnded) return;
      inputEnded = true;
      try { file.flush(); } catch (error: any) {
        post({ type: 'error', message: `MP4 flush failed: ${String(error?.message || error)}` });
      }
      sortPending();
      pump();
      maybePostEnd();
    },
    pull(count: number): void {
      credit += Math.max(0, Math.min(2000, Math.floor(count) || 0));
      pump();
    },
    bufferedSamples(): number {
      return pending.length;
    },
    stop(): void {
      stopped = true;
      pending.length = 0;
      try { file.stop(); } catch {}
    }
  };
}

export function serializeConfigurationBox(box: { write(stream: any): void } | undefined): ArrayBuffer | undefined {
  if (!box) return undefined;
  const stream = new DataStream();
  box.write(stream as any);
  const size = stream.byteLength;
  if (size <= 8) return undefined;
  const written = stream.buffer.slice(0, size);
  const view = new DataView(written);
  const declaredSize = view.getUint32(0);
  const headerSize = declaredSize === 1 ? 16 : 8;
  if (size <= headerSize) return undefined;
  return written.slice(headerSize, size);
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
