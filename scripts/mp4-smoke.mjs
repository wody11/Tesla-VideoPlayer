import { createFile } from 'mp4box';

const url = process.argv[2];
if (!url) throw new Error('Usage: node scripts/mp4-smoke.mjs <mp4-url>');

const response = await fetch(url);
if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
const buffer = await response.arrayBuffer();
const file = createFile();
let info;
let videoSamples = 0;
let audioSamples = 0;

file.onError = error => { throw new Error(String(error)); };
file.onSamples = (_id, kind, samples) => {
  if (kind === 'video') videoSamples += samples.length;
  else audioSamples += samples.length;
};
file.onReady = value => {
  info = value;
  for (const track of value.videoTracks) file.setExtractionOptions(track.id, 'video', { nbSamples: 256 });
  for (const track of value.audioTracks) file.setExtractionOptions(track.id, 'audio', { nbSamples: 512 });
  file.start();
};

buffer.fileStart = 0;
file.appendBuffer(buffer);
file.flush();

console.log(JSON.stringify({
  bytes: buffer.byteLength,
  videoCodec: info?.videoTracks?.[0]?.codec,
  audioCodec: info?.audioTracks?.[0]?.codec,
  videoSamples,
  audioSamples,
  duration: info ? info.duration / info.timescale : 0,
  audioDescriptor: (() => {
    const track = info?.audioTracks?.[0];
    const entry = track ? file.getTrackById(track.id)?.mdia?.minf?.stbl?.stsd?.entries?.[0] : undefined;
    const esd = entry?.esds?.esd;
    const describe = descriptor => descriptor ? {
      tag: descriptor.tag,
      dataLength: descriptor.data?.byteLength,
      children: descriptor.descs?.map(describe)
    } : null;
    return { entryKeys: entry ? Object.keys(entry) : [], esdsKeys: entry?.esds ? Object.keys(entry.esds) : [], tree: describe(esd) };
  })()
}, null, 2));
