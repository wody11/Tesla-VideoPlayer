# Progressive MP4 path

The active Worker downloads MP4 data in sequential 2 MiB Range chunks. If a
server ignores Range and returns HTTP 200, it consumes the response body as a
stream. Each chunk is appended directly to MP4Box with its `fileStart`.

The Worker never assembles a second full-file `ArrayBuffer`.

Extraction flow:

```text
network chunk → MP4Box appendBuffer → track config → pending samples
              → main-thread pull credit → transferable sample event
              → releaseUsedSamples
```

Backpressure uses both:

- a main-thread pull-credit window;
- a Worker pending-sample high-water mark.

Fast-start files can begin playback before download completes. Files with a
trailing `moov` box must download enough data to discover metadata first.

Current codec policy:

- video: AVC/HEVC/AV1/VP9 when supported by browser WebCodecs;
- audio: AAC (`mp4a.40.*`) only.
