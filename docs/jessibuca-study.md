# Jessibuca open-source design study

This note records the design ideas Tesla-VideoPlayer can reuse without importing
or copying Jessibuca runtime code.

## Player initialization

Jessibuca separates the public facade from the internal player. The facade
validates the container, normalizes options, protects against duplicate
instances on one container, creates the internal player, and re-emits internal
events as public API events. The internal player then creates the video surface,
audio graph, stream loader, demuxer, worker bridge, optional WebCodecs decoder,
optional MSE decoder, controls, timers, and stats loop.

Tesla should keep the same high-level split: a small public class owns
lifecycle and user commands, while stream fetch, demux, decode, render, audio,
clock, stats, and errors stay in isolated modules.

## Worker message protocol

Jessibuca uses command-like messages between the main thread and decoder worker:

- main to worker: init, decode, audioDecode, videoDecode, close, updateConfig.
- worker to main: init, videoCode, audioCode, initVideo, initAudio, render,
  playAudio, wasmError, and telemetry messages.

The important pattern is a narrow protocol with explicit config, media samples,
render/audio outputs, close, and error messages. Tesla uses typed messages in
`src/worker/worker-protocol.ts` so the worker can be deleted or replaced without
touching the player facade.

## HTTP-FLV and WS-FLV data flow

Jessibuca chooses fetch for HTTP URLs and WebSocket for non-HTTP live URLs, then
feeds byte chunks into the FLV demuxer. The FLV demuxer consumes the 9-byte FLV
header, previous-tag-size fields, and tag headers, then dispatches audio tag 8
and video tag 9 payloads downstream.

Tesla's standalone stage now implements HTTP-FLV and a minimal HLS path
(`m3u8 -> TS -> H.264/AAC samples`). WS-FLV is left as a TODO.

## Demux flow

Jessibuca's FLV path classifies tags and forwards payloads with timestamps. For
H.264, the AVC packet header decides sequence-header versus frame data; for AAC,
the AAC packet type decides AudioSpecificConfig versus raw AAC frame.

Tesla mirrors this design at the data-flow level: the worker parses FLV tags,
emits `video-config`, `audio-config`, `video-sample`, and `audio-sample`
messages, and never decodes in the worker for the WebCodecs path.

## WebCodecs decode flow

Jessibuca configures `VideoDecoder` from the AVCDecoderConfigurationRecord
inside the FLV sequence header, waits for the first keyframe after configure,
and emits explicit errors for unsupported codecs, configure failures, decode
failures, and size changes.

Tesla configures `VideoDecoder` and `AudioDecoder` on the main thread. The first
implementation supports H.264/AVC and AAC. H.265, G.711, and dynamic codec
switches are TODO items instead of silent success.

## WASM software fallback

Jessibuca ships an FFmpeg-derived WASM decoder and can fall back from WebCodecs
or MSE to WASM when configured. Its worker reports decoded YUV/PCM frames to the
main thread.

Tesla does not copy or depend on that WASM. The fallback plan is documented as a
TODO: introduce a Tesla-owned decoder package with an explicit worker protocol
that outputs decoded video frames or YUV planes and PCM blocks. Until that
exists, WebCodecs absence is reported as an unsupported capability.

## Canvas/WebGL rendering

Jessibuca creates a canvas inside the player container. It chooses WebGL for
YUV-plane rendering, bitmaprenderer for offscreen paths, or 2D canvas drawing
for WebCodecs `VideoFrame`.

Tesla provides both `CanvasRenderer` and `WebGLRenderer`. The WebGL renderer
uploads `VideoFrame` directly as a texture for the WebCodecs path. The 2D
renderer uses `drawImage`. Neither path uses a `video` element.

## WebAudio playback

Jessibuca owns an `AudioContext`, a `GainNode`, and an audio buffer queue. The
WASM path feeds PCM through ScriptProcessor; WebCodecs/MSE paths avoid extra
worker delay where possible.

Tesla's `WebAudioPlayer` receives decoded `AudioData`, copies it into
`AudioBuffer`, schedules it against an `AudioContext` clock, and exposes queued
milliseconds for stats.

## Audio/video sync

Jessibuca tracks audio and video timestamps. In the WASM path it compares audio
timestamp to video timestamp, waits if audio is too far ahead, and drops audio
buffers if audio falls too far behind. Video buffering also derives delay from
local wall time versus stream timestamp.

Tesla uses audio as the primary clock when audio exists. Video frames are
scheduled relative to the first audio timestamp; if audio is not configured yet,
video uses a wall-clock fallback. Late video frames are dropped when they exceed
the allowed lateness window.

## Buffer queue design

Jessibuca keeps demux queues and audio queues bounded, measures live delay, and
enters a dropping mode when the stream exceeds the configured buffer plus delay
window.

Tesla keeps small decode queues in the main thread and exposes
`videoQueueLength` and `audioQueueMs`. It drops late decoded frames and can later
add a worker-side GOP drop mode once HTTP-FLV backpressure is tuned.

## Frame dropping

Jessibuca's demux layer drops until a keyframe when live delay is too high, then
leaves dropping mode after delay returns under the buffer target.

Tesla's initial stage drops decoded video frames that are too late relative to
the audio clock. TODO: add pre-decode GOP dropping in the FLV worker so overloaded
streams do less decode work.

## Errors and reconnect

Jessibuca names errors for fetch, WebSocket, WebGL, MSE, WebCodecs configure,
WebCodecs decode, WASM decode, stream end, loading timeout, and delay timeout.
The facade can pause, reset, and replay on selected errors.

Tesla emits typed error events and surfaces the message in the demo. Reconnect is
documented as TODO in the first standalone chain; the worker supports stop/abort
so reconnect can be added as a facade policy without changing demux internals.

## Multi-instance playback

Jessibuca prevents duplicate players on the same container and keeps player
state, worker, renderer, audio graph, timers, and stats per instance.

Tesla follows per-instance ownership. Each player creates its own canvas,
renderer, audio context, decoder pair, worker, stats object, and event emitter.

## Stats

Jessibuca tracks fps, audio/video bitrate, current timestamp, buffer delay, and
play-to-render milestone timings.

Tesla's standalone stats include the required acceptance metrics:
`decoderType`, `rendererType`, `videoTagCount`, `canvasCount`, `fps`,
`decodedFrames`, `droppedFrames`, `audioQueueMs`, `videoQueueLength`,
`firstFrameTimeMs`, and `currentTimeMs`.
