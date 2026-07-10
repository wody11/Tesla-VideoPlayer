# Jessibuca Migration Notes

Tesla-VideoPlayer was reorganized using Jessibuca open source edition as the architectural reference.

## Jessibuca-Inspired Modules

- Player lifecycle, state/events/stats separation: `src/player/*`
- Worker command/event boundary: `src/worker/worker-protocol.ts`, `worker-client.ts`, `worker-session.ts`
- Stream loader split: `src/stream/http-loader.ts`, `websocket-loader.ts`
- FLV parsing boundary: `src/demux/flv/*`
- Decoder abstraction and fallback policy: `src/decoder/*`
- Render/audio/control separation: `src/render/*`, `src/audio/*`, `src/control/*`
- Drop-frame and AV-sync policy modules: `src/sync/*`

## Tesla-Origin Modules Retained

- WebCodecs H.264/AAC decode path
- HLS/m3u8 playlist and TS demux logic
- Canvas/WebGL no-video rendering
- WebAudio scheduling and audio clock
- Tesla demo diagnostics for video/canvas tag counts
- No-video runtime guard

## Runtime Dependency Decision

The final build does not depend on the old top-level `jessibuca/` checkout. Jessibuca runtime assets are vendored in `vendor/jessibuca-runtime/`, and a source snapshot is vendored in `vendor/jessibuca-src/`.

## Incomplete Feature Parity

Not every Jessibuca feature is fully implemented yet. The code marks incomplete areas with TODOs and explicit runtime errors:

- WASM soft decoding bridge
- H.265/G711 decoding on no-video path
- MP4 VOD sample extraction
- OffscreenCanvas rendering
- AudioWorklet scheduling
