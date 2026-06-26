# Tesla playback strategy

This document captures the Jessibuca-style ideas that Tesla-VideoPlayer should
keep as first-class playback policy, not ad-hoc fixes.

## Strategy model

Use three explicit presets:

- `low-latency`: smallest live delay, more willing to drop late video.
- `balanced`: default for live HLS/FLV, moderate audio buffer and bounded video
  queue.
- `smooth`: larger audio/render buffer, less aggressive dropping, useful when
  network jitter is visible.

## Pipeline rules

- Preserve demux output order for compressed video. Do not globally sort H.264
  samples by PTS before decode; B frames need decoder input order to remain
  valid.
- Sort only decoded render frames, because `VideoFrame.timestamp` is presentation
  time.
- Configure decoders as soon as codec data is available. Queue samples until
  configure completes.
- Keep SPS/PPS with keyframes in TS demux output.

## Buffer rules

- HLS live starts from the newest segment by default, matching low-delay player
  behavior.
- Fetch one live segment per poll by default. Increasing this improves smoothness
  but adds delay.
- Decode video in small batches per animation frame so one TS segment does not
  stall the main thread.
- Maintain a bounded render queue. Drop only frames that are too late or when the
  queue grows beyond the configured cap.

## Audio rules

- Do not drop normal audio frames just because the queue is above target; this
  creates audible gaps.
- Schedule audio continuously with WebAudio.
- If audio queue is higher than target, use a tiny playback-rate catch-up.
- If audio queue becomes extreme, reset the scheduled sources rather than
  letting live delay grow forever.

## Error and retry rules

- Playlist/segment fetch failures should retry with short backoff before
  surfacing an error.
- Unsupported codec/encryption should fail explicitly.
- WebCodecs unsupported should fail explicitly; WASM fallback is TODO until
  Tesla owns a decoder implementation.

## UI rules

- The stage must fit in the viewport; settings panels scroll independently.
- Expose strategy presets plus advanced knobs so tuning is visible and
  repeatable.
- Keep `video` element count at zero during playback.
