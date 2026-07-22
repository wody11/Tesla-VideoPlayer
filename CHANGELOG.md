# Change Log

## Unreleased

### Responsive player, controls, and playback smoothness

- Added width-first responsive sizing with visual-viewport caps and decoded-video aspect ratios.
- Replaced temporary buttons with one mobile-friendly auto-hiding control bar shared by all engines.
- Added VOD progress, time display, mute, volume, screenshot, fullscreen, keyboard, and touch-friendly controls.
- Reworked WebAudio scheduling to use explicit planar-float copies, a continuous timeline, bounded startup lead, and faded resets instead of per-frame playback-rate changes.
- Added live-audio queue trimming, audio underrun/reset/drop diagnostics, requestAnimationFrame rendering, and timestamp-ordered frame insertion.
- Assigned monotonic durations to multiple H.264 access units carried in one TS PES and decoded PCR without signed 32-bit overflow.
- Prevented duplicate state/video-size events, made failed runtime scripts retryable, and resumed H.265 without rebuilding the player.
- Released WebGL shaders, buffers, textures, and programs and added context-loss restoration.
- Added layout, audio scheduling, control formatting, and queue helper tests.

### Stability and deterministic lifecycle

- Fixed AES-128 HLS double PKCS#7 unpadding.
- Added session/generation IDs to reject stale Worker, decoder, frame, timer, and
  audio callbacks.
- Added decoder and queue backpressure.
- Fatal engine errors now terminate the current session.
- Preserved media samples whose timestamp is exactly zero.
- Scoped NoVideoGuard to each player container.
- Added rapid-switch, stop, error-recovery, AES, timestamp, queue, and guard tests.

### Progressive playback and API completion

- Reworked MP4 to append Range/stream chunks incrementally to MP4Box.
- Added MP4 pull credit, pending-sample high-water mark, and sample release.
- Added HLS discontinuity pipeline reset.
- Applied `decoderMode`, controls, autoplay, presets, volume, renderer, fit mode,
  advanced queue options, and reconnect options at runtime.
- Separated media counters from scoped DOM diagnostics and reset stats per media
  session.
- Removed the old parallel Worker, unused bundle, empty facades, and placeholder
  modules.
- Added engine-routing, option, stats, MP4, and discontinuity tests.

### Documentation

- Expanded English and Chinese READMEs.
- Added API reference and development guide.
- Updated architecture, playback strategy, Jessibuca migration/study, Worker,
  HLS, MP4, and controls documentation.
- Moved the Chinese technical whitepaper to a readable documentation path.
