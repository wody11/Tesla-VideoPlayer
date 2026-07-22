# Public API Reference

## Construction

```ts
const player = createTeslaPlayer(container, options);
```

Equivalent class forms:

```ts
new TeslaPlayer(container, options);
new TeslaPlayer({ container, ...options });
```

The container is required. The player sets a relative positioning context and
creates Canvas/control elements inside it.

## Options

| Option | Type | Default | Behavior |
|---|---|---:|---|
| `url` | `string` | — | Initial URL. Used with `autoplay` when supplied at construction. |
| `decoderMode` | `auto \| webcodecs \| wasm` | `auto` | Selects the engine route described below. |
| `renderer` | `canvas \| webgl` | `webgl` | Tesla WebCodecs renderer. Falls back to Canvas2D if WebGL creation fails. |
| `fitMode` | `contain \| cover \| fill` | `contain` | Controls visual fitting. |
| `controls` | `boolean` | `false` | Adds/removes the Tesla control overlay. |
| `autoplay` | `boolean` | `false` | Starts playback in a microtask when `url` is present. Browser audio policy may still block audio resume. |
| `preset` | `low-latency \| balanced \| smooth` | `balanced` | Applies queue, batching, and late-frame thresholds. |
| `volume` | `number` | `1` | Clamped to `0..1` and applied before first playback. |
| `workerUrl` | `string` | built asset URL | Overrides `worker-entry.js`. |
| `jessibucaUrl` | `string` | built asset URL | Overrides the Jessibuca runtime script. |
| `decoderUrl` | `string` | built asset URL | Overrides the Jessibuca decoder Worker/WASM bootstrap. |
| `h265webUrl` | `string` | — | External h265web.js runtime URL. |
| `enableH265Web` | `boolean` | `false` | Allows explicit `sourceType: "h265"` routing. |
| `liveStartSegmentCount` | `number` | route default | Number of newest HLS live segments considered at startup. |
| `liveSegmentBatch` | `number` | route default | Number of live HLS segments fetched per polling cycle. |
| `audioMaxQueueMs` | `number` | preset/runtime default | Target upper bound for scheduled audio. |
| `decodeBatchSize` | `number` | preset default | Maximum video samples submitted per decode tick. |
| `maxRenderQueue` | `number` | preset default | Maximum decoded video frames retained for rendering. |
| `lateDropMs` | `number` | preset default | Late-video threshold before frames are dropped. |
| `reconnect` | `boolean` | `true` | Enables retry for HTTP-FLV, WS-FLV, and HLS. |
| `reconnectMaxRetries` | `number` | `3` | Maximum retries after the initial attempt. |
| `reconnectDelayMs` | `number` | `1000` | Base retry delay; attempt number multiplies this value. |
| `videoBuffer` | `number` | `0.2` | Jessibuca FLV buffer setting. |
| `debug` | `boolean` | `false` | Jessibuca diagnostic logging. |
| `loadingText` | `string` | `loading` | Jessibuca loading text. |
| `responsive` | `boolean` | `true` | Sizes the container from available width and caps it to the visible browser viewport. |
| `aspectRatio` | `number \| video` | `video` | Numeric width/height ratio, or `video` to follow decoded frame dimensions. |
| `maxViewportHeightRatio` | `number` | `1` | Maximum fraction of the visual viewport height occupied by the player; clamped to `0.25..1`. |

`TeslaLoadOptions` accepts all options above plus an explicit `sourceType`.

## Source types and engine routing

`sourceType` values:

```ts
'http-flv' | 'ws-flv' | 'hls' | 'mp4' | 'h265' | 'unknown'
```

Routing rules:

- HLS/MP4 + `auto` or `webcodecs` → Tesla WebCodecs engine.
- HLS/MP4 + `wasm` → explicit error.
- HTTP/WS FLV + `auto` or `wasm` → Jessibuca.
- HTTP/WS FLV + `webcodecs` → Tesla WebCodecs engine.
- H.265 → only when `enableH265Web` is true and runtime assets exist.

URL inference recognizes `.m3u8`, `.mp4`, `.flv`, WebSocket FLV, and a specific
`mime_type=video_mp4` query. Generic HTTP(S) URLs fall back to HTTP-FLV, so
extensionless HLS/MP4 URLs should pass `sourceType` explicitly.

## Methods

### `load(url, options?)`

Stores a source and normalized options, resets per-session stats, applies volume,
controls, renderer, and playback settings. It does not start playback.

### `play(url?, options?)`

Optionally loads a new URL and starts the resolved engine. Calling this after
`destroy()` throws.

### `pause()` / `resume()` / `togglePlayback()`

Pauses or resumes the active engine. `resume()` and `togglePlayback()` are asynchronous. Calling `play()` with no new URL while paused also resumes the existing engine instead of rebuilding it.

### `stop()`

Cancels reconnect timers, stops the active engine, and transitions to `stopped`.
The player instance remains reusable.

### `destroy()`

Destroys engines, controls, guards, timers, and event listeners. The instance is
not reusable afterward.

### `seek(seconds)`

Available only for MP4 and HLS on-demand playback through the WebCodecs engine.
Live HLS behavior is not guaranteed.

### `setVolume(value)` / `getVolume()`

Clamps the value to `0..1`, applies it to the active and future engine, and returns the normalized value through `getVolume()`.

### `setPlaybackRate(rate)`

Currently unsupported. It emits a `log` event and makes no playback change.

### `screenshot()`

Returns a PNG data URL for the Tesla WebCodecs canvas. The Jessibuca route asks
Jessibuca for a base64 screenshot. Returns an empty string when unavailable.

### `fullscreen()`

Toggles Fullscreen API state for the player container.

### `getState()` / `getStats()` / `getContainer()`

Returns the current state, a `TeslaPlayerStats` snapshot, or the owned container.

### `setRenderer(renderer)` / `updateSettings(options)`

Changes the WebCodecs renderer or reapplies normalized runtime options without creating a new public player instance. Responsive layout, volume, controls, presets, and queue limits update immediately where supported.

## Events

```ts
player.on('state', state => {});
player.on('error', error => {});
player.on('stats', stats => {});
player.on('log', message => {});
player.on('firstFrame', milliseconds => {});
player.on('reconnect', attempt => {});
player.on('videoSize', ({ width, height, aspectRatio }) => {});
```

`on()` returns an unsubscribe function. External listener exceptions are caught
so they do not break playback internals. The Jessibuca route emits periodic
`stats` events; for the Tesla WebCodecs route, call `getStats()` on the cadence
required by the application.

## Stats fields

`getStats()` returns:

- route identity: `sourceType`, `decoderType`, `rendererType`, `audioType`;
- media counters: `videoTagCount`, `audioSampleCount`;
- scoped DOM diagnostics: `videoElementCount`, `canvasCount`;
- performance: `fps`, `decodedFrames`, `droppedFrames`, `firstFrameTimeMs`;
- queues and clock: `audioQueueMs`, `videoQueueLength`, `currentTime`,
  `currentTimeMs`, `duration`;
- audio diagnostics: `audioDecodedFrames`, `audioScheduledSources`,
  `audioFrameSamples`, `audioContextState`, `audioTimelineResets`,
  `audioUnderruns`, `audioStartupBufferMs`, `audioDroppedSamples`;
- transport/recovery: `bitrate`, `reconnectCount`, `discontinuityCount`,
  `downloadedBytes`, `totalBytes`, `lastError`.

Stats reset when a new media session is loaded or started. DOM counts are scoped
to the current player container rather than the whole document.

## Responsive layout and controls

With `responsive: true`, player height is derived from available width, then capped by the visual viewport. This prevents a portrait page or portrait source from stretching beyond the browser screen. `aspectRatio: "video"` starts at 16:9 and switches to the first decoded video dimensions. Fullscreen temporarily fills the fullscreen viewport.

The unified control bar is used for every engine, so Jessibuca's internal buttons are disabled to prevent duplicate overlays. Controls auto-hide during playback and support Space/K (play/pause), M (mute), F (fullscreen), Left/Right (seek five seconds for VOD), and double-click fullscreen.
