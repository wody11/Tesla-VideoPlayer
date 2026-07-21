# Architecture

## Design goals

Tesla-VideoPlayer keeps fetch, demux, decode, clocks, queues, rendering, and
recovery visible to application code. The Tesla WebCodecs route must not create
an HTML `video` element or use MSE.

## Runtime entries

- `src/index.ts`: public exports and optional browser globals.
- `src/player/tesla-player.ts`: public facade, routing, controls, reconnect.
- `src/player/hls-webcodecs-engine.ts`: Tesla WebCodecs session.
- `src/worker/worker-entry.ts`: the only playback Worker entry.
- `src/worker/http-flv-worker.ts`: HTTP/WS FLV, HLS/TS, and progressive MP4 I/O.
- `src/worker/worker-protocol.ts`: typed main-thread/Worker boundary.

The earlier parallel `src/worker/index.ts` and unused `worker.js` bundle were
removed. There is one active Worker path so fixes cannot land in dead code.

## Playback routes

### Tesla WebCodecs route

```text
Network
  → Worker fetch/playlist/demux
  → typed config/sample events
  → WebCodecs VideoDecoder/AudioDecoder
  → bounded decoded-frame/audio queues
  → Canvas2D or WebGL + WebAudio
```

Used for HLS, MP4, and FLV when `decoderMode: "webcodecs"`.

### Jessibuca route

```text
HTTP/WS FLV
  → vendored Jessibuca WASM runtime
  → Canvas/WebGL + WebAudio
```

Used for FLV when `decoderMode` is `auto` or `wasm`. MSE and HTML-video options
are disabled in the Tesla integration.

### Experimental H.265 route

`H265WebEngine` is opt-in and requires separately supplied h265web.js browser
runtime and WASM assets. The vendored npm snapshot is not sufficient by itself.

## Player and session lifecycle

`TeslaPlayer` is the long-lived public object. Each Tesla WebCodecs playback is a
short-lived session with a monotonically increasing generation ID.

Starting A then B performs this order:

1. increment generation;
2. make every A callback stale;
3. terminate A's Worker, decoders, audio, timers, and queued frames;
4. create B's resources;
5. accept callbacks only when their captured generation is current.

This applies to Worker messages, decoder configuration promises, decoded frames,
audio resume promises, render timers, and decode timers.

A fatal engine error invalidates and releases the current session before the
error is emitted. `stop()` also invalidates the session but leaves the outer
player reusable. `destroy()` permanently tears down the player.

## Progressive MP4

The Worker requests sequential 2 MiB byte ranges when supported. If the server
ignores Range and returns HTTP 200, the response body is still consumed as a
stream. Each chunk is appended directly to MP4Box with the correct `fileStart`.
No second full-file `ArrayBuffer` is assembled.

MP4Box extraction is controlled by:

- main-thread pull credit;
- a Worker-side buffered-sample high-water mark;
- bounded main-thread compressed and render queues;
- `releaseUsedSamples()` after transferred samples are consumed.

Fast-start MP4 can begin extraction before download completes. A trailing `moov`
still delays metadata discovery but does not require full-file duplication.

## HLS

The Worker parses media and master playlists, selects the current variant,
fetches MPEG-TS segments, optionally decrypts AES-128, and emits H.264/AAC config
and samples.

When a segment has `EXT-X-DISCONTINUITY`, the Worker emits a discontinuity event.
The main engine then:

- closes and recreates WebCodecs decoders;
- clears compressed and decoded queues;
- closes queued frames;
- resets audio scheduling and A/V clock bases;
- clears codec-configured flags;
- waits for fresh codec configuration and a keyframe.

This protects against timestamp resets and codec-parameter changes.

## Backpressure and queue boundaries

The pipeline has several independent limits:

1. Worker MP4 extraction waits for pull credit and its sample high-water mark.
2. Live compressed video queues are trimmed and restart from a keyframe.
3. `VideoDecoder.decodeQueueSize` and `AudioDecoder.decodeQueueSize` gate decode.
4. Decode work runs in bounded batches.
5. Render queue length is capped by the active preset/option.
6. Late decoded frames are closed and counted as dropped.
7. WebAudio queue length gates further audio decode.

Every dropped or stale decoded frame is explicitly closed.

## Clock and rendering

Audio is the preferred media clock. Video delay is calculated against scheduled
audio media time. Before audio is ready, video uses a wall-clock base. Decoded
frames are sorted by presentation timestamp only after decode; compressed H.264
input order is preserved.

## Options and engine reuse

`TeslaPlayer.load()` normalizes options and applies volume, controls, renderer,
fit mode, presets, and advanced queue settings. A reused WebCodecs engine receives
updated settings and renderer selection before the next play.

Reconnect is centralized in `TeslaPlayer` for HTTP-FLV, WS-FLV, and HLS. Each
retry stops the active engine, increments stats, emits `reconnect`, waits an
attempt-scaled delay, and starts a fresh session.

## Stats

Stats are reset per media session. Media counters are distinct from DOM
instrumentation:

- `videoTagCount` and `audioSampleCount`: media pipeline observations;
- `videoElementCount` and `canvasCount`: DOM elements inside this player's
  container only.

Additional fields cover decode/render/drop counts, queue lengths, first-frame
time, reconnects, discontinuities, bitrate, MP4 download progress, and last
error.

## Current limitations

- HLS supports MPEG-TS H.264/AAC, not fMP4/CMAF or SAMPLE-AES.
- MP4 audio currently requires AAC.
- HLS/MP4 software decoding is not implemented.
- h265web.js needs external runtime/WASM assets.
- playback-rate control is not implemented.
