import { canDecodeVideo, insertByTimestamp, trimLiveAudioQueue, trimLiveVideoQueue } from './playback-flow';

describe('playback flow control', () => {
  test('stops feeding VideoDecoder when its internal queue is full', () => {
    expect(canDecodeVideo(true, 5, 10, 23, 120, 24)).toBe(true);
    expect(canDecodeVideo(true, 5, 10, 24, 120, 24)).toBe(false);
  });

  test('stops feeding VideoDecoder when the render queue is full', () => {
    expect(canDecodeVideo(true, 5, 120, 0, 120)).toBe(false);
  });

  test('trims a live backlog to the newest decodable key-frame boundary', () => {
    const queue = [
      { id: 1, key: true },
      { id: 2, key: false },
      { id: 3, key: false },
      { id: 4, key: true },
      { id: 5, key: false },
      { id: 6, key: false }
    ];

    expect(trimLiveVideoQueue(queue, 3)).toBe(3);
    expect(queue.map(item => item.id)).toEqual([4, 5, 6]);
  });

  test('clears an undecodable live backlog that contains no recent key frame', () => {
    const queue = [
      { id: 1, key: true },
      { id: 2, key: false },
      { id: 3, key: false },
      { id: 4, key: false },
      { id: 5, key: false }
    ];

    expect(trimLiveVideoQueue(queue, 3)).toBe(5);
    expect(queue).toEqual([]);
  });
});


describe('audio and render queue helpers', () => {
  test('trims stale live audio while preserving the newest window', () => {
    const queue = Array.from({ length: 10 }, (_, index) => ({ timestamp: index * 100_000, duration: 100_000 }));
    expect(trimLiveAudioQueue(queue, 350_000, 20)).toBe(6);
    expect(queue.map(sample => sample.timestamp)).toEqual([600_000, 700_000, 800_000, 900_000]);
  });

  test('inserts uncommon out-of-order frames without sorting the whole queue', () => {
    const queue = [{ timestamp: 10 }, { timestamp: 30 }];
    insertByTimestamp(queue, { timestamp: 20 });
    expect(queue.map(item => item.timestamp)).toEqual([10, 20, 30]);
  });
});
