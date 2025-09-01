import { demuxTS, TSSample } from '../ts/demux-ts';

// Minimal TS demux utilities (skeleton)
export function parsePAT(payload: Uint8Array) { /* ... */ }
export function parsePMT(payload: Uint8Array) { /* ... */ }
export function readPTS(data: Uint8Array, off: number) { /* ... */ }

export async function fetchAndDemuxTS(url: string): Promise<TSSample[]> {
	// 拉取 TS 分片
	const res = await fetch(url);
	if (!res.ok) throw new Error('TS fetch failed: ' + res.status);
	const buf = await res.arrayBuffer();
	// 解复用
	return demuxTS(buf);
}
