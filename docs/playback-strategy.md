# Playback Strategy

Playback policy is explicit and testable rather than scattered across ad-hoc
timeouts.

## Presets

| Preset | Goal | Audio target | Decode batch | Render queue | Late drop |
|---|---|---:|---:|---:|---:|
| `low-latency` | minimum live delay | 900 ms | 10 | 80 | 160 ms |
| `balanced` | default compromise | 1500 ms | 8 | 120 | 240 ms |
| `smooth` | tolerate jitter | 2600 ms | 6 | 180 | 420 ms |

Explicit advanced options override or update these values.

## Compressed-sample rules

- Preserve demux/decode input order. Do not sort compressed H.264 samples by PTS;
  B-frame streams need decode order.
- Do not submit delta frames before the first keyframe.
- For live queue overload, discard old compressed video and restart from the
  newest retained keyframe.
- Preserve timestamp zero. `tsUs === 0` is valid media time.

## Decoder rules

- Configure as soon as codec data is available.
- Queue samples while asynchronous `isConfigSupported/configure` work completes.
- Reject stale configuration completions by generation ID.
- Gate video submission using `VideoDecoder.decodeQueueSize`.
- Gate audio submission using both `AudioDecoder.decodeQueueSize` and scheduled
  WebAudio duration.
- Decode in short batches so a segment cannot monopolize the main thread.

## Render and A/V sync rules

- Sort decoded `VideoFrame` objects by presentation timestamp.
- Use scheduled audio time as the primary clock.
- Use a wall-clock base only while audio is unavailable.
- Wait for early frames, draw due frames, and close frames that exceed the late
  threshold.
- Cap the render queue and close every evicted frame.

## HLS live rules

- Start near the newest available segment.
- Fetch a small segment batch per poll.
- Treat discontinuity as a new decode epoch: reset decoders, queues, clocks, and
  keyframe/config gating.
- Retry transient playlist or segment failures before escalating.

## MP4 rules

- Append network chunks directly to MP4Box; never build a second whole-file copy.
- Respect main-thread sample credit and Worker high-water marks.
- Release used MP4Box samples after transferring their data.
- A seek starts a fresh playback session so old samples and decoder callbacks
  cannot leak across the seek boundary.

## Error and retry rules

- Unsupported codec, encryption, source route, and browser capability failures
  must be explicit.
- Fatal engine errors terminate the active generation before emitting `error`.
- The outer player owns retry policy for HTTP-FLV, WS-FLV, and HLS.
- MP4 is not automatically retried because a partial VOD failure should be
  surfaced deterministically rather than silently restarting from the beginning.

## UI rules

- Controls are optional and scoped to the player container.
- NoVideoGuard observes only that container.
- A `video` element elsewhere on the page must not break playback.
