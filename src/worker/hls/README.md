# HLS Worker path

The HLS path supports master/media playlists and MPEG-TS H.264/AAC media.

Flow:

```text
m3u8 → select variant → fetch segment → optional AES-128 decrypt
     → TS demux/PES reassembly → H.264/AAC config and samples
```

Supported behavior:

- live and VOD playlists;
- media sequence and target duration;
- VOD start-time mapping and seek via a fresh session;
- AES-128 full-segment encryption;
- `EXT-X-DISCONTINUITY` events;
- live polling with bounded segment batches.

Important rules:

- WebCrypto AES-CBC already validates/removes PKCS#7 padding; do not strip it a
  second time.
- `tsUs === 0` is valid and must be emitted.
- Discontinuity requires fresh codec configuration and keyframe gating on the
  main thread.

Not supported:

- SAMPLE-AES;
- fMP4/CMAF and `EXT-X-MAP`;
- `EXT-X-BYTERANGE`;
- alternate audio/subtitle renditions and adaptive bitrate switching.
