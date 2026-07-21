# Jessibuca Design Study

> Historical design note updated to reflect the current Tesla implementation.
> For normative behavior, use `README.md`, `docs/api.md`, and
> `docs/architecture.md`.

## Reused ideas

Jessibuca's most useful design pattern is separation of concerns: a public
facade owns lifecycle and user commands, while stream loading, demux, decode,
render, audio, controls, timers, errors, and stats remain isolated.
Tesla-VideoPlayer follows this split through `TeslaPlayer`, the Tesla WebCodecs
engine, the active Worker protocol, render/audio modules, and optional controls.

## FLV routes

Both HTTP-FLV and WS-FLV are implemented.

- `decoderMode: "auto"` or `"wasm"` selects the vendored Jessibuca software
  decoder.
- `decoderMode: "webcodecs"` selects Tesla's FLV demux + WebCodecs path.

The Tesla Worker parses FLV headers and tags, emits H.264/AAC configuration and
samples, and leaves decoding to main-thread WebCodecs.

## HLS and MP4 routes

Tesla owns these routes rather than delegating them to Jessibuca:

- HLS media/master playlist parsing, AES-128, MPEG-TS demux, live polling, VOD
  seek, and discontinuity reset;
- progressive MP4 Range/stream loading, incremental MP4Box append/extraction,
  and pull-credit backpressure.

## Decode and rendering

Tesla configures `VideoDecoder` and `AudioDecoder`, rejects stale async
configuration by session generation, and bounds decoder input. Video renders to
Canvas2D or WebGL; audio is copied into WebAudio buffers and scheduled against an
AudioContext clock.

No HTML `video` or MSE is used on the Tesla WebCodecs route.

## Buffering and frame dropping

The current implementation includes:

- bounded live compressed-video queue with keyframe restart;
- `VideoDecoder.decodeQueueSize` and audio decode-queue gating;
- bounded decode batches;
- bounded render queue;
- late decoded-frame dropping;
- MP4 pull credit and Worker sample high-water mark;
- WebAudio scheduled-duration limits.

## Errors and reconnect

Fatal WebCodecs-engine errors terminate the current generation before emitting
an error. `TeslaPlayer` provides one reconnect policy for HTTP-FLV, WS-FLV, and
HLS, with retry count and attempt-scaled delay options.

## Deliberately unsupported areas

- HLS/MP4 WASM bridge;
- HLS SAMPLE-AES and fMP4/CMAF;
- Tesla WebCodecs G.711/Opus;
- playback-rate control;
- h265web.js without external runtime/WASM assets.
