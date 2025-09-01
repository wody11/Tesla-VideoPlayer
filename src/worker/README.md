Worker-side code. Build to `worker.js` for runtime. The worker implements network IO, demux, bitstream filtering
and posts samples/config/logs back to the main thread.

What to implement

- IOReader: fetch + ReadableStream reader abstraction (supports abort and seek for VOD).
- HLS playlist handling: parse m3u8, download TS segments, support AES-128 decryption when needed.
- TS demux: PAT/PMT → PES reassembly → extract ES (H.264 NALs, AAC ADTS frames).
- BSF: H.264 AnnexB ↔ AVCC conversion, SPS/PPS extraction, AAC ADTS → RAW and ASC generation.

Build

This repo uses TypeScript sources under `src/worker/`. You should bundle/compile them to a single `worker.js` consumed by the main app. Example toolchains:

- rollup (recommended): bundle `src/worker/index.ts` → `worker.js` (watch mode for dev).
- webpack: configure a worker entry and emit `worker.js`.

Quick dev tip (not included): create a simple rollup config with `@rollup/plugin-typescript` to emit `worker.js`.

Message protocol (summary)

- From main → worker
	- `{ type: 'openHLS', url }`
	- `{ type: 'openFLV', url }`
	- `{ type: 'seek', ms }`
	- `{ type: 'close' }`

- From worker → main
	- `{ type: 'ready', durationMs, video?, audio? }`
	- `{ type: 'ready-hls', isLive, durationMs }`
	- `{ type: 'sample', kind, ts, dur, key, data }` (Transferable)
	- `{ type: 'log', msg }`
	- `{ type: 'error', msg }`

Debugging tips

- Use `postMessage({ type:'log', msg: '...' })` liberally inside the worker to inspect parsing state.
- Limit log frequency for hot loops (e.g. only log first N occurrences of a condition).
- When testing HLS, run with a small set of segments and enable the mux.js probe to extract avcC early.

Runtime expectations

- The worker should be resilient to partial/fragmented PES data; keep a small carry buffer per PID.
- When SPS/PPS change mid-stream, post a new `ready`/`hls-config` with updated `description` and reset key-gating on main thread.

License: project-local (check top-level LICENSE if present).
