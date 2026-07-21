# Jessibuca Migration Notes

Tesla-VideoPlayer uses Jessibuca as an architectural reference and vendors its
runtime for the FLV software-decoding route.

## Current relationship

- FLV + `decoderMode: "auto"` or `"wasm"` uses the vendored Jessibuca runtime.
- FLV + `decoderMode: "webcodecs"` uses Tesla's Worker/WebCodecs route.
- HLS and MP4 use Tesla's Worker/WebCodecs route.
- Jessibuca MSE and HTML-video paths are disabled in Tesla integration.

The project is GPL-3.0-only. See `THIRD_PARTY_NOTICES.md` and the vendored license
files.

## Jessibuca-inspired structure

- public facade vs. internal engines;
- explicit lifecycle, state, events, and stats;
- Worker command/event boundary;
- stream/demux/decode/render/audio separation;
- bounded buffering, error naming, and reconnect policy;
- optional controls and diagnostics.

## Tesla-owned implementation

- HLS playlist parsing and MPEG-TS demux;
- progressive MP4 Range/stream ingestion and MP4Box demux;
- WebCodecs decoder management;
- Canvas2D/WebGL rendering;
- WebAudio scheduling and media clock;
- session generation and stale-callback rejection;
- HLS discontinuity reset;
- scoped NoVideoGuard and per-session stats.

## Removed migration scaffolding

The old parallel Worker implementation, unused Worker bundle, empty loader
facades, and placeholder modules were removed. There is one active Worker entry:
`src/worker/worker-entry.ts`.

## Remaining gaps

These are explicit product limitations, not silent fallbacks:

- no typed software-decoder bridge for HLS/MP4;
- no HLS SAMPLE-AES or fMP4/CMAF;
- no G.711/Opus path in Tesla WebCodecs FLV;
- no playback-rate implementation;
- h265web.js requires external runtime/WASM assets;
- no OffscreenCanvas or AudioWorklet path.
