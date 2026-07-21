# Tesla-VideoPlayer

Tesla-VideoPlayer is a browser media player that keeps the playback pipeline under
application control. Its Tesla WebCodecs path demuxes media in a Worker, decodes
with WebCodecs, renders to Canvas/WebGL, and outputs audio through WebAudio. It
never relies on an HTML `video` element or MSE on that path.

The project also vendors the Jessibuca runtime for FLV software decoding when
`decoderMode` is `auto` or `wasm`.

## Features

- HTTP-FLV and WebSocket-FLV playback.
- HLS VOD/live with MPEG-TS H.264/AAC, AES-128, master playlists, VOD seek, and
  `EXT-X-DISCONTINUITY` resets.
- Progressive MP4 download and incremental MP4Box demuxing.
- WebCodecs video/audio decode with Canvas2D or WebGL rendering.
- Session/generation isolation for rapid source switching and stale callbacks.
- Bounded compressed, decoder, render, and audio queues.
- Shared reconnect policy for FLV and HLS.
- Optional built-in controls, screenshots, fullscreen, runtime stats, and a
  container-scoped no-video guard.

## Playback routes

| Source | `decoderMode` | Runtime route |
|---|---|---|
| HLS | `auto`, `webcodecs` | Worker demux → WebCodecs → Canvas/WebGL → WebAudio |
| MP4 | `auto`, `webcodecs` | Progressive download → MP4Box → WebCodecs → Canvas/WebGL → WebAudio |
| HTTP/WS FLV | `auto`, `wasm` | Jessibuca WASM → Canvas/WebGL → WebAudio |
| HTTP/WS FLV | `webcodecs` | Worker FLV demux → WebCodecs → Canvas/WebGL → WebAudio |
| Experimental H.265 | explicit opt-in | h265web.js integration, only when external runtime/WASM assets are supplied |

HLS and MP4 reject `decoderMode: "wasm"` because the project does not yet have a
typed software-decoder bridge for those containers.

## Requirements

The WebCodecs route requires:

- a browser with `VideoDecoder` and `AudioDecoder`;
- Worker, WebAudio, Canvas2D or WebGL support;
- CORS access to the media URL;
- byte-range support for the most efficient MP4 playback.

Serve the build from HTTP(S). Browser Worker and module loading generally do not
work correctly from `file://` URLs.

## Install and build

```bash
npm ci
npm test
npm run typecheck
npm run build
```

Build output:

- `dist/index.js`: public player API;
- `dist/worker-entry.js`: the only Tesla playback Worker entry;
- vendored Jessibuca runtime assets copied into `dist/`.

## Quick start

```ts
import { createTeslaPlayer } from './dist/index.js';

const container = document.querySelector<HTMLElement>('#player');
if (!container) throw new Error('Player container is missing.');

const player = createTeslaPlayer(container, {
  decoderMode: 'auto',
  renderer: 'webgl',
  fitMode: 'contain',
  controls: true,
  autoplay: false,
  preset: 'balanced',
  volume: 0.8,
  reconnect: true,
  reconnectMaxRetries: 3,
  reconnectDelayMs: 1000
});

player.on('state', state => console.log('state', state));
player.on('error', error => console.error(error));
player.on('reconnect', attempt => console.log('reconnect attempt', attempt));

player.load('https://example.com/live.m3u8', { sourceType: 'hls' });
await player.play();
```

For extensionless or signed URLs, always pass `sourceType` explicitly because
URL inference otherwise treats generic HTTP(S) URLs as HTTP-FLV.

## Public API

Main methods:

- `load(url, options?)`
- `play(url?, options?)`
- `pause()` / `resume()` / `stop()` / `destroy()`
- `seek(seconds)` for MP4 and HLS VOD
- `setVolume(0..1)`
- `screenshot()`
- `fullscreen()`
- `getState()` / `getStats()`
- `on(event, listener)` / `off(event, listener)`

`setPlaybackRate()` currently reports an unsupported-operation log and does not
change playback speed.

See [docs/api.md](docs/api.md) for options, events, routing, and stats fields.

## Support matrix and limitations

- HTTP-FLV / WS-FLV: H.264 + AAC.
- HLS: MPEG-TS H.264 + AAC. SAMPLE-AES, fMP4/CMAF, `EXT-X-MAP`, and byte-range
  playlists are not implemented.
- MP4: H.264/H.265/AV1/VP9 video subject to browser WebCodecs support; AAC audio
  is currently required.
- H.265 through h265web.js remains experimental because the vendored package does
  not include the required browser runtime and WASM files.
- Playback-rate control is not implemented.

## Documentation

- [API reference](docs/api.md)
- [Architecture](docs/architecture.md)
- [Development guide](docs/development.md)
- [Playback strategy](docs/playback-strategy.md)
- [Jessibuca migration notes](docs/jessibuca-migration.md)
- [H.265 integration study](docs/h265web-study.md)
- [Chinese technical whitepaper](docs/technical-whitepaper-cn.md)
- [Change log](CHANGELOG.md)

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party software and
licenses.
