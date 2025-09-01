import { ReorderBuffer } from './reorder';

describe('ReorderBuffer', () => {
  test('popRenderable respects lookahead and minBufferFrames', () => {
    const rb = new ReorderBuffer({ minBufferFrames: 2 });
    const base = 1_000_000; // 1s
    // push out of order pts
  rb.push({ ptsUs: base + 100_000, key: false }); // 1.1s
  rb.push({ ptsUs: base + 33_000, key: true });   // 1.033s (IDR)
  rb.push({ ptsUs: base + 66_000, key: false });  // 1.066s

    // audio at 1.000s, lookAhead 80ms -> should render pts <= 1.080s, but keep 2 frames in buffer if possible
    const out = rb.popRenderable(base, 80_000);
    // pts sorted: 1.033, 1.066, 1.100. cutoff <= 1.080 -> up to 1.066
    // keep tail 2 frames -> buffer has 3, so cutoff = min(idx+1=2, len-keep=1) = 1
    expect(out.length).toBe(1);
  expect(out[0].ptsUs).toBe(base + 33_000);
  });

  test('dropOlderThan removes old frames', () => {
    const rb = new ReorderBuffer({ minBufferFrames: 1 });
    const base = 2_000_000;
    rb.push({ ptsUs: base + 0, key: true });
    rb.push({ ptsUs: base + 50_000, key: false });
    rb.push({ ptsUs: base + 100_000, key: false });
    const dropped = rb.dropOlderThan(base + 60_000);
    expect(dropped).toBe(2);
    const out = rb.popRenderable(base + 60_000, 100_000);
  expect(out.length).toBe(0);
  });
});
