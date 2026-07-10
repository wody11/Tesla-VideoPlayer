/*
 * MP4 sample reader facade. The existing MP4 demuxer is intentionally minimal;
 * fragmented MP4 playback remains marked experimental in the worker.
 */

export { parseInit, parseFragment } from './mp4-demuxer';

