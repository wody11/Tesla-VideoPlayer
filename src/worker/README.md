# Active playback Worker

`src/worker/worker-entry.ts` is the only runtime Worker entry. It imports
`http-flv-worker.ts`, which handles:

- HTTP-FLV and WebSocket-FLV fetch/stream parsing;
- HLS playlist polling, AES-128 decrypt, and MPEG-TS demux;
- progressive MP4 Range/stream loading and MP4Box demux.

The typed boundary is `worker-protocol.ts`.

The Worker owns network I/O and demux only. WebCodecs, WebAudio, Canvas/WebGL,
player state, reconnect, and DOM remain on the main thread.

Important invariants:

- abort the previous open operation before starting another;
- transfer media `ArrayBuffer`s instead of retaining copies;
- preserve valid timestamp zero;
- do not assemble a second complete MP4 file;
- respect MP4 pull credit and sample high-water marks;
- emit explicit errors for unsupported encryption or codecs;
- emit `discontinuity` before samples from a discontinuous HLS segment.

Build output: `dist/worker-entry.js`.
