# Development Guide

## Prerequisites

- Node.js 20 or newer is recommended.
- npm with lockfile support.
- A current Chromium-based browser for WebCodecs smoke tests.
- A local HTTP server; do not rely on `file://` for Worker/module tests.

## Setup

```bash
npm ci
npm test
npm run typecheck
npm run build
```

Useful scripts:

| Script | Purpose |
|---|---|
| `npm test` | Runs Jest unit tests in-band. |
| `npm run typecheck` | Runs `tsc --noEmit`. |
| `npm run lint` | Currently aliases type checking. |
| `npm run build` | Builds the public entry and the sole Worker entry, then copies Jessibuca assets. |
| `npm run build:demo` | Builds the demo bundle when the demo Rollup config is present. |

## Repository layout

```text
src/player/       public facade, engine routing, lifecycle, stats, reconnect
src/worker/       active Worker entry, protocol, FLV/HLS/MP4 demux
src/decoder/      WebCodecs configuration and sample submission
src/audio/        WebAudio scheduling and audio clock
src/render/       Canvas2D and WebGL rendering
src/control/      unified optional control overlay
src/ui/           responsive player layout helpers
src/sync/         reusable queue/sync helpers
src/utils/        capability checks, generation guard, no-video guard
docs/             architecture, API, strategy, research notes
vendor/           vendored Jessibuca and h265web.js snapshots
```

`src/worker/worker-entry.ts` is the only Worker build entry. Do not add a parallel
Worker implementation unless it replaces the active path in Rollup and the old
path is removed in the same change.

## Runtime ownership

`TeslaPlayer` owns:

- engine selection and lifecycle;
- reconnect policy;
- public state/events/stats;
- controls and the container-scoped NoVideoGuard.

`HlsWebCodecsEngine` owns the Tesla WebCodecs session:

- Worker, WebCodecs decoders, WebAudio, renderer;
- session/generation identity;
- compressed/decode/render queues and timers;
- fatal-session cleanup and HLS discontinuity reset.

The Worker owns network I/O and demux. It sends typed messages from
`worker-protocol.ts`; it does not render or mutate player DOM.

## Adding or changing Worker messages

1. Update `TeslaWorkerCommand` or `TeslaWorkerEvent` in
   `src/worker/worker-protocol.ts`.
2. Update both sender and receiver in the same commit.
3. Transfer `ArrayBuffer` payloads rather than cloning where possible.
4. Make stale callbacks harmless by checking the session generation on the main
   thread.
5. Add unit tests for protocol-dependent pure helpers.

## Queue and memory rules

- Never assemble a second complete MP4 file in memory.
- MP4Box input must carry the correct `fileStart` offset.
- Respect pull credit and sample high-water marks.
- Keep decoder queue, compressed sample queue, render queue, and audio queue
  bounded.
- When dropping live compressed video, restart from a keyframe.
- Close every discarded `VideoFrame` and `AudioData`.
- Schedule WebAudio buffers contiguously; do not correct backlog by changing each source's playback rate.
- Use explicit `f32-planar` AudioData copies before creating AudioBuffers.
- Release MP4Box samples after transfer.

## HLS rules

- AES-CBC decryption must rely on WebCrypto's padding handling; do not manually
  strip PKCS#7 after `subtle.decrypt`.
- Preserve timestamp zero (`tsUs === 0`).
- A discontinuity must reset decoder configuration, keyframe gating, render and
  compressed queues, and audio/video clocks.
- SAMPLE-AES and fMP4 HLS are unsupported and must fail explicitly rather than
  silently producing broken playback.

## Error and lifecycle rules

- Fatal engine errors terminate the current session and release its resources.
- Rapid A→B source switches invalidate A before resources are closed.
- Old Worker, decoder-config, frame, timer, and audio-resume callbacks must not
  mutate B.
- `stop()` keeps the player reusable; `destroy()` does not.
- Reconnect is owned by `TeslaPlayer`, not by individual engines.

## Tests

The test suite covers:

- HLS playlist parsing, seek mapping, encryption handling, and discontinuity;
- TS/PES/AAC/H.264 helpers;
- AES decrypt behavior;
- session generation and playback-flow queue logic;
- player option normalization and engine routing;
- scoped NoVideoGuard and stats reset;
- MP4 configuration-box extraction and progressive demux helpers.

For browser smoke tests, verify at least:

1. HLS VOD and live first frame;
2. MP4 starts before the complete file downloads when `moov` is at the front;
3. HTTP-FLV and WS-FLV in both supported routes;
4. rapid source switching and stop during decoder configuration;
5. HLS discontinuity with timestamp reset;
6. no leaked `video` elements inside the player container;
7. repeated play/stop/destroy cycles do not grow Worker, AudioContext, WebGL, or frame
   counts indefinitely;
8. portrait viewport sizing never makes the player taller than its configured visual-viewport cap;
9. audio discontinuities and backlog recovery do not overlap sources or create audible clicks.

## Pull request checklist

Before publishing a change:

```bash
npm ci
npm test
npm run typecheck
npm run build
```

Also confirm:

- no generated `dist/` files are accidentally committed unless release policy
  explicitly requires them;
- no patch, ZIP, media fixture, or credential file is staged;
- README/API/architecture docs match changed behavior;
- new runtime branches have deterministic errors and tests;
- third-party license notices remain intact.
