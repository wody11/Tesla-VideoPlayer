import { canDecodeVideo, trimLiveVideoQueue } from './playback-flow';

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
