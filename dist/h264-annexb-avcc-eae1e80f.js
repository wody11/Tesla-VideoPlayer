// H.264 AnnexB <-> AVCC 转换工具
// 负责 NALU 格式转换，提取 SPS/PPS，构造 avcC
function extractSpsPps(buffer) {
    const u8 = new Uint8Array(buffer);
    const sps = [];
    const pps = [];
    const len = u8.length;
    function startCodeLen(pos) {
        if (pos + 3 < len && u8[pos] === 0 && u8[pos + 1] === 0) {
            if (u8[pos + 2] === 1)
                return 3;
            if (pos + 4 < len && u8[pos + 2] === 0 && u8[pos + 3] === 1)
                return 4;
        }
        return 0;
    }
    let i = 0;
    while (i < len) {
        while (i < len && startCodeLen(i) === 0)
            i++;
        const sc = startCodeLen(i);
        if (!sc)
            break;
        const start = i + sc;
        i = start;
        while (i < len && startCodeLen(i) === 0)
            i++;
        const end = i;
        if (end > start) {
            const nalu = u8.subarray(start, end);
            const nalType = nalu[0] & 0x1f;
            if (nalType === 7)
                sps.push(nalu.slice().buffer);
            else if (nalType === 8)
                pps.push(nalu.slice().buffer);
        }
    }
    return { sps, pps };
}
// H.264 AnnexB <-> AVCC helpers (skeleton)
// 已合并到 avccToAnnexB(input, nalLengthSize)
function buildAVCCDesc(sps, pps) {
    const arr = new Uint8Array(7 + 2 + sps.length + 1 + 2 + pps.length);
    let o = 0;
    arr[o++] = 1;
    arr[o++] = sps[1];
    arr[o++] = sps[2];
    arr[o++] = sps[3];
    arr[o++] = 0xff;
    arr[o++] = 0xe1;
    arr[o++] = (sps.length >> 8) & 0xff;
    arr[o++] = sps.length & 0xff;
    arr.set(sps, o);
    o += sps.length;
    arr[o++] = 1;
    arr[o++] = (pps.length >> 8) & 0xff;
    arr[o++] = pps.length & 0xff;
    arr.set(pps, o);
    return arr;
}

export { buildAVCCDesc, extractSpsPps };
//# sourceMappingURL=h264-annexb-avcc-eae1e80f.js.map
