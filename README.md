# Tesla-VideoPlayer

Tesla-VideoPlayer is a no-video browser player rebuilt around the Jessibuca open source architecture and distributed under GPL-3.0.

## Origin And License

This project is based on the architecture of Jessibuca open source edition:

- Jessibuca repository: https://github.com/langhuihui/jessibuca
- Jessibuca license: GPL-3.0
- Tesla-VideoPlayer license: GPL-3.0
- Third-party notice: `THIRD_PARTY_NOTICES.md`
- Vendored Jessibuca runtime: `vendor/jessibuca-runtime/`
- Vendored Jessibuca source snapshot: `vendor/jessibuca-src/`
- Vendored h265web.js package snapshot: `vendor/h265webjs/`

## Playback Goal

The default Tesla path does not use HTML `video` elements and does not use MSE:

`MP4 / HLS / HTTP-FLV / WS-FLV -> Worker loading and demux -> WebCodecs or WASM -> Canvas/WebGL -> WebAudio`

Unsupported paths report explicit errors or TODOs instead of silently falling back to video tags.

## Public Entry

```ts
import { createTeslaPlayer } from './dist/index.js';

const player = createTeslaPlayer(document.querySelector('#player')!, {
  decoderMode: 'auto',
  renderer: 'webgl',
  controls: true
});

player.load('https://example.com/live.flv');
await player.play();
```

## API

- `load(url, options)`
- `play()`
- `pause()`
- `resume()`
- `stop()`
- `destroy()`
- `seek(time)`
- `setVolume(volume)`
- `setPlaybackRate(rate)`
- `screenshot()`
- `fullscreen()`
- `getStats()`
- `getState()`
- `on(event, handler)`
- `off(event, handler)`

## Current Support

- HTTP-FLV and WS-FLV: H.264 + AAC through Jessibuca WASM and Canvas/WebGL
- HLS/m3u8 VOD and live: MPEG-TS H.264/AAC through WebCodecs/WebAudio; master playlists, AES-128, pause/resume and VOD seek are supported; SAMPLE-AES is not
- MP4 VOD: ISO-BMFF demux to WebCodecs/WebAudio; H.264/H.265/AV1/VP9 video (subject to browser support), AAC audio, pause/resume and second-based seek
- Every default path avoids `video` elements and MSE; `NoVideoGuard` checks this continuously during playback
- WASM: Jessibuca-style fallback architecture is present, full bridge is TODO
- H.265/G711: pending the WASM decoder bridge
- h265web.js: study-only plus explicit experimental entry, not enabled by default; the npm package lacks the actual `dist/h265webjs.js`/wasm runtime asset

MP4/HLS requires WebCodecs, WebAudio, Worker and Canvas/WebGL. Cross-origin media servers must allow CORS. MP4 uses concurrent Range chunks and assembles them in the worker before demux; progressive sample extraction while downloading remains future work.

## Build

```bash
npm install
npm run build
```

Build output is emitted to `dist/`.
