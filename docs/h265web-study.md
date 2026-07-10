# h265web.js Study For Tesla No-Video Mode

## Scope

This note studies the vendored `h265web.js@2.2.2` package under `vendor/h265webjs/`.

Important finding: the npm package contains documentation, demo glue, and a tiny `dist/index.js`, but it does not include the actual browser runtime `dist/h265webjs.js` or wasm decoder files referenced by the README. Therefore Tesla must not enable h265web.js by default.

## Claimed Playback Types

The README claims support for:

- `mp4` VOD
- `m3u8` VOD
- `hls` live
- `ts`
- `raw265`

The public config includes:

- `type: "mp4" | "hls" | "ts" | "raw265"`
- `player`: DOM id of the player container
- `accurateSeek`
- `moovStartFlag`

## Playback Cores

### MSE / HTML Video Route

The vendored npm snapshot does not contain enough core source to verify whether an internal MSE/video route exists. For Tesla policy, any h265web.js path that requires `MediaSource`, `SourceBuffer`, or an HTML `video` element is marked:

`Not suitable for Tesla no-video`

Tesla must not migrate or enable that path in no-video mode.

### WebCodec Route

No usable WebCodecs implementation is present in the npm snapshot. There is no complete decoder core in `vendor/h265webjs/dist/`.

Status:

`Reference only / not enabled`

### WASM Route

The README says users must copy `dist/*.wasm` next to `h265webjs.js`. The npm package we received does not contain those wasm files.

Potentially useful ideas:

- H.265/HEVC wasm decode for MP4/HLS/TS/raw265
- raw265 byte feeding via `append265raw(chunk)`
- `mediaInfo()` for codec/duration/live-vod metadata

Status:

`Potentially suitable for Tesla no-video after actual runtime/wasm assets are supplied`

### Canvas / WebGL Route

The included `screen.js` uses:

- `document.createElement("canvas")`
- `yuv-buffer`
- `yuv-canvas`
- YUV frame callback rendering

This route is compatible with Tesla no-video as long as it does not create HTML `video`.

Tesla no-video requirement:

```js
document.querySelectorAll('video').length === 0
document.querySelectorAll('canvas').length >= 1
```

## APIs Worth Referencing

- `mediaInfo()`: exposes media metadata such as duration, codec info, VOD/live type.
- `seek(pts)`: seek by timestamp.
- `onPlayTime(videoPTS)`: playback clock update.
- `onLoadCache` / `onLoadCacheFinshed`: buffering state.
- `onRender(width, height, imageBufferY, imageBufferB, imageBufferR)`: decoded YUV frames.
- `setRenderScreen(flag)`: enable/disable render frame callback.
- `append265raw(chunk)`: feed raw H.265 byte stream.

## Tesla Migration Decision

Do not default-enable h265web.js.

Acceptable to reference:

- HLS/m3u8 manifest and TS handling concepts
- MP4 parsing and seek concepts
- raw265 append/feed model
- WASM decoder bridge model
- YUV Canvas rendering model
- MediaInfo and playback time callbacks

Do not migrate:

- Any route that requires HTML `video`
- Any MSE route as Tesla no-video default
- Any unverified h265web.js runtime behavior until `dist/h265webjs.js` and wasm assets are available

## Current Tesla Status

Tesla includes a disabled integration layer in `src/player/h265web-engine.ts`.

It is not automatically selected by URL inference. It only runs when `sourceType: "h265"` and `enableH265Web: true` are explicitly provided, and it will still fail clearly until the missing runtime file is supplied:

```text
vendor/h265webjs/dist/h265webjs.js
vendor/h265webjs/dist/*.wasm
```

