# Tesla-VideoPlayer
<div align="center">
  <a href="README-cn.md">中文简介</a> | <a href="README.md">English</a>
</div>


A **no-`<video>`/no-MSE** playback core for the web:
**Demux in a Worker** → **decode with WebCodecs on the main thread** → **render via Canvas/WebGL** + **sync with WebAudio**.
Designed for HLS/MP4/FLV with a “small core, pluggable edges” philosophy.
You can enable web players to stream media while driving in various Tesla models, including the Model Y, Model X, Model 3, and Model S.

> Great when you need full control (precise clocking, fully owned AV pipeline, no `<video>` black box).

---

<p align="center">
  <img alt="status" src="https://img.shields.io/badge/status-alpha-orange">
  <img alt="webcodecs" src="https://img.shields.io/badge/WebCodecs-required-blue">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green">
</p>

## ✨ Highlights

* **Worker-side demux**: parse HLS/TS/MP4/FLV off the main thread, reduce jank.
* **Native WebCodecs**: `VideoDecoder` + `AudioDecoder`, hardware acceleration when available.
* **Canvas/WebGL rendering**: 2D by default, switchable to WebGL for future color/scale work.
* **WebAudio master clock**: audio-driven A/V sync; **PCR/video wall-clock fallback** before audio lock.
* **AVCC/AnnexB auto-handling**: detect and **inject SPS/PPS** on keyframes to avoid black/garbled frames.
* **Fast first frame**: feed the first keyframe immediately + a few nearby deltas for **faster startup**.
* **Hot re-config**: seamlessly reconfigure `AudioDecoder` when sample rate/channels change.
* **Runtime tuning knobs**: look-ahead, drop window, in-flight depth, bootstrap window, etc.
* **Stall detection**: emits `buffering/playing` based on scheduled-audio horizon & video queue.
* **Soft-decode hooks**: `ffmpeg.wasm` placeholders ready (not enabled by default).

> These cover a lot of hard edges many players don’t handle—or don’t handle robustly.

---

## 🧠 Architecture at a Glance

```
           Fetch / Playlist / HLS
                    │
                    ▼
              ┌─────────────┐
              │   Worker     │  ← demux / ts normalization / segment orchestration
              └─────┬───────┘
                    │ postMessage(sample / config / events)
                    ▼
      ┌──────────────────────────────────┐
      │               Main               │
      │  WebCodecs (Video/Audio) decode  │
      │  Canvas/WebGL render + WebAudio  │
      └──────────────────────────────────┘
                    │
                    ▼
            Canvas & AudioContext
```

---

## 📦 Install & Quick Start

```bash
# install deps (pnpm/yarn also fine)
npm i
npm run build

# serve the demo (pick your favorite static server)
npx http-server .
```

Minimal example (TypeScript):

```ts
import { PlayerCore } from './player-core';

const canvas = document.getElementById('video') as HTMLCanvasElement;

const player = new PlayerCore({
  canvas,
  renderer: '2d',             // or 'webgl'
  enableSoftwareFallback: false, // ffmpeg.wasm hook is a placeholder
});

// Optional: set start pos for HLS VOD
player.setStartPositionMs(0);

// Events
player.on('playing',   () => console.log('playing'));
player.on('buffering', () => console.log('buffering'));
player.on('ended',     () => console.log('ended'));
player.on('error',     (e: any) => console.error(e));

// Load & play
await player.load('https://example.com/path/index.m3u8'); // .m3u8 / .mp4 / .flv
await player.play();
```

> ⚠️ The Worker script is loaded from `dist/index.js` (fallback to `worker.js`).
> Ensure it’s **same-origin** (or properly CORS-enabled) and path-accessible in production.

---

## 🛠️ API Overview

### Constructor

```ts
new PlayerCore({
  canvas: HTMLCanvasElement,
  renderer?: '2d'|'webgl',
  videoLookAheadMs?: number,   // ~80ms default
  dropWindowMs?: number,       // ~120ms default
  leadWindowMs?: number,       // ~200ms default (LIVE often higher)
  maxVideoInFlight?: number,   // 6 default
  maxVideoQueue?: number,      // 180 default
  usePcrBeforeAudio?: boolean, // true default
  enableSoftwareFallback?: boolean, // wasm hooks (placeholder)
  stallAudioMinAheadS?: number, // buffering threshold with audio
  stallNoAudioIdleMs?: number,  // buffering threshold without audio
});
```

### Playback control

```ts
await player.load(url);
await player.play();
await player.pause();
await player.stop();
await player.seek(ms);

player.setPlaybackRate(1.25);
player.setMuted(true);
player.setVolume(0.8);

player.goLive(); // HLS live: jump to tail
```

### Rendering pipeline

```ts
player.attachCanvas(newCanvas, 'webgl'); // swap canvas/renderer
player.setRenderer('2d'|'webgl');
```

### Runtime tuning

```ts
player.setLookAheadMs(100);
player.setDropWindowMs(120);
player.setLeadWindowMs(120);        // VOD 80–120ms often sweet spot
player.setMaxVideoInFlight(6);
player.setMaxVideoQueue(180);
player.setStallThresholds(0.03, 500);
player.setBootstrapFeed(500, 20);   // startup window & frames
player.setUsePcrBeforeAudio(true);
player.setContinuousTimeline(true); // UI-continuous timeline
```

### Queries

```ts
player.getStats();             // { framesDrawn, framesDropped, videoQueue }
player.getSeekable();          // { startMs, endMs, isLive }
player.getCurrentTimeMs();     // timeline-aware “current time”
player.getDurationMs();        // VOD duration if known
player.getBufferState();       // { audioAheadS, videoQueued, ... }
player.getPlaybackRate();
player.getMuted();
player.getVolume();
player.getVideoQueueSize();
player.getAudioConfiguredInfo(); // { sampleRate, channels }
player.getVideoDriftUs();      // video drift vs audio master clock
player.isBuffering();
```

### Events

* `playing`: buffering satisfied / rendering resumed.
* `buffering`: underflow / waiting for data or decode.
* `ended`: stream ended or reached tail.
* `error`: decode/render/network errors bubbled up.

---

## 🔧 Worker Protocol (convention)

* Downstream (to Worker): `openHLS | openFLV | open (mp4-url) | openMP4(init)`, `fetchSegment`, `seek`.
* Upstream (to main thread):

  * `ready-mp4` / `stream-info` / `config-update`
  * `sample(kind='audio'|'video', {ts,dts,pcr,dur,key,data})`
  * `hls-playlist` / `hls-pos` / `duration`
  * `buffering` / `playing` / `eos` / `log` / `discontinuity`

> Timestamps are **normalized to microseconds** and **aligned to a shared epoch** in the Worker to simplify main-thread alignment.

---

## 🧪 Browser Support (short)

* **Chromium family** with modern WebCodecs.
* Safari 16+ partially workable (verify for your streams/devices).
* Firefox currently doesn’t ship WebCodecs by default (experiment at your own risk).

Run coverage tests on your real target fleet before production.

---

## 🚀 Tuning Cheatsheet

| Scenario           | lookAheadMs | dropWindowMs | leadWindowMs | inFlight |
| ------------------ | ----------: | -----------: | -----------: | -------: |
| VOD                |      80–120 |      100–140 |   **80–120** |      4–6 |
| LIVE (low latency) |      60–100 |       80–120 |  **180–240** |      3–5 |
| Low-end devices    |     100–160 |      140–200 |      120–160 |      2–4 |

Tips:

* During startup you can **temporarily enlarge `leadWindowMs`** to ensure quick visuals; reduce later for lip-sync strictness.
* If UI is heavy, prefer `renderer: 'webgl'` and keep `inFlight` modest.

---

## ❓ FAQ

**Only audio / no video / time not advancing?**

* Ensure **keyframes arrive** (enable logs with `window.__DEMO_DEBUG = true`).
* Check CORS/Range support for your segments.
* Turn on `usePcrBeforeAudio=true` so PCR/video wall-clock can **temporarily drive the clock** before audio is ready.
* Make sure `AudioContext.resume()` actually runs on user gesture / HTTPS.

**HLS demo fetches all segments at once?**

* The demo intentionally keeps it simple. In production, implement **on-demand fetching** (1–3s look-ahead) and **ABR**.

**Colors look washed?**

* Try `renderer: 'webgl'` and add BT.709/range mapping in the renderer (todo sample).

---

## 🗺️ Roadmap

* [ ] ABR (throughput/buffer-driven)
* [ ] WebGL renderer (color space / scalers / sharpening)
* [ ] OffscreenCanvas + Worker rendering
* [ ] `ffmpeg.wasm` soft-fallback (start with audio)
* [ ] Subtitles (WebVTT/ASS) & external audio
* [ ] Record/snapshot/filters
* [ ] DRM (EME/ClearKey, etc.)

---

## 🤝 Contributing

Please open Issues/PRs with:

* Repro steps (URL/segment traits/browser versions)
* Console + `__DEMO_DEBUG` logs
* Output of `getStats()` / `getBufferState()` snapshots

---

## 📜 License

[MIT](./LICENSE)

---


