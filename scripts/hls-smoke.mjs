import { decodePesTimestamp, demuxTS } from '../dist/index.js';

const playlistUrl = process.argv[2];
if (!playlistUrl) throw new Error('Usage: node scripts/hls-smoke.mjs <m3u8-url>');

const playlistResponse = await fetch(playlistUrl);
if (!playlistResponse.ok) throw new Error(`Playlist HTTP ${playlistResponse.status}`);
const playlist = await playlistResponse.text();
const segmentLine = playlist.split(/\r?\n/).findLast(line => line && !line.startsWith('#'));
if (!segmentLine) throw new Error('Playlist has no media segment.');
const segmentUrl = new URL(segmentLine, playlistUrl).href;
const segmentResponse = await fetch(segmentUrl);
if (!segmentResponse.ok) throw new Error(`Segment HTTP ${segmentResponse.status}`);
const segment = await segmentResponse.arrayBuffer();
const samples = demuxTS(segment);
const video = samples.filter(sample => sample.kind === 'video');
const audio = samples.filter(sample => sample.kind === 'audio');
const pesTimestamps = [];
const bytes = new Uint8Array(segment);
for (let offset = 0; offset + 188 <= bytes.length && pesTimestamps.length < 12; offset += 188) {
  if (bytes[offset] !== 0x47 || !(bytes[offset + 1] & 0x40)) continue;
  const afc = (bytes[offset + 3] >> 4) & 3;
  let payload = offset + 4;
  if (afc === 2 || afc === 3) payload += 1 + bytes[offset + 4];
  if (payload + 14 > offset + 188 || bytes[payload] !== 0 || bytes[payload + 1] !== 0 || bytes[payload + 2] !== 1) continue;
  const streamId = bytes[payload + 3];
  if ((streamId & 0xe0) !== 0xc0 || !(bytes[payload + 7] & 0x80)) continue;
  pesTimestamps.push({
    bytes: Array.from(bytes.slice(payload + 9, payload + 14)),
    value: decodePesTimestamp(bytes, payload + 9)
  });
}

console.log(JSON.stringify({
  segmentUrl,
  segmentBytes: segment.byteLength,
  videoSamples: video.length,
  audioSamples: audio.length,
  audioDurationMs: audio.reduce((sum, sample) => sum + sample.durUs, 0) / 1000,
  audioTimestamps: audio.slice(0, 8).map(sample => sample.tsUs)
  ,pesTimestamps
}, null, 2));
