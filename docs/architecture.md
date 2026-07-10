# Tesla-VideoPlayer Architecture

Tesla-VideoPlayer now follows a Jessibuca-style modular layout:

- `src/player`: public API, state machine, events, errors, stats, options.
- `src/stream`: HTTP/WebSocket/HLS/MP4 loader facades.
- `src/demux`: FLV, HLS/TS, MP4 demux boundaries and shared sample/timestamp helpers.
- `src/decoder`: WebCodecs decoder manager and explicit WASM fallback hook.
- `src/render`: Canvas 2D, WebGL, render manager, OffscreenCanvas placeholder.
- `src/audio`: WebAudio scheduling, queue and manager.
- `src/sync`: AV sync, frame queue, drift correction and drop-frame policy.
- `src/worker`: worker entry, protocol, client and session lifecycle.
- `src/control`: control bar, play/pause, volume, fullscreen, screenshot and stats panel.
- `src/utils`: logger, event emitter, environment, capability and no-video guard.

## Active No-Video Path

HTTP-FLV, WS-FLV, HLS and MP4 are routed through no-video engines. HLS and MP4 use a worker to demux TS/ISO-BMFF and post compressed samples to WebCodecs; decoded VideoFrames render through Canvas/WebGL and AudioData is scheduled through WebAudio. FLV uses the vendored Jessibuca WASM/Canvas runtime with MSE and WebCodecs media-element paths disabled.

HTML `video` and MSE fallback paths are disabled for the default Tesla mode. `NoVideoGuard` reports an error if any `video` element appears during playback.

## H.265 / HEVC

Tesla has a disabled h265web.js study/adapter layer for explicit `sourceType: "h265"` experiments. It is not selected by default URL inference. The npm snapshot is vendored under `vendor/h265webjs/`, but it does not include the actual browser runtime file `dist/h265webjs.js`, so this path remains disabled unless `enableH265Web` is explicitly set and the missing runtime/wasm assets are supplied.

## TODO Items

- WASM decoder bridge: Jessibuca GPL `decoder.js`/`decoder.wasm` are documented as source assets, but the typed bridge to Tesla frame/audio queues is not complete.
- H.265 and G711: detected as unsupported in the active WebCodecs path unless the future WASM bridge is enabled.
- Progressive MP4 extraction: downloads use concurrent Range chunks, but MP4Box extraction still starts after the complete file is assembled.
- OffscreenCanvas renderer and AudioWorklet scheduling are placeholders.
