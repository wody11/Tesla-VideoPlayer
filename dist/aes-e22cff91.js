// HLS AES-128 (CBC) 解密工具（使用 WebCrypto）
async function decryptAes128CbcPkcs7(data, keyBytes, ivBytes) {
    const subtle = self.crypto?.subtle;
    if (!subtle)
        throw new Error('WebCrypto SubtleCrypto not available');
    const dataBuf = data instanceof Uint8Array ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data;
    const keyBuf = keyBytes instanceof Uint8Array ? keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) : keyBytes;
    const ivBuf = ivBytes instanceof Uint8Array ? ivBytes.buffer.slice(ivBytes.byteOffset, ivBytes.byteOffset + ivBytes.byteLength) : ivBytes;
    const key = await subtle.importKey('raw', keyBuf, { name: 'AES-CBC' }, false, ['decrypt']);
    const plain = await subtle.decrypt({ name: 'AES-CBC', iv: ivBuf }, key, dataBuf);
    // 去除 PKCS#7 填充（TS 常见）
    const u8 = new Uint8Array(plain);
    if (u8.length === 0)
        return plain;
    const pad = u8[u8.length - 1];
    if (pad > 0 && pad <= 16 && pad <= u8.length) {
        // 校验最后 pad 字节都相等（宽松模式：仅检查首尾两位）
        if (u8[u8.length - pad] === pad) {
            return u8.subarray(0, u8.length - pad).slice().buffer;
        }
    }
    return plain;
}
function hexToBytes(hex) {
    const h = hex.startsWith('0x') ? hex.slice(2) : hex;
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++)
        out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
}
function seqToIv(mediaSequence) {
    // HLS 规范：当未提供 IV 时，IV 为 16 字节的大端无符号整数，值为媒体序列号
    const iv = new Uint8Array(16);
    const view = new DataView(iv.buffer);
    view.setUint32(12, mediaSequence >>> 0);
    return iv;
}

export { decryptAes128CbcPkcs7, hexToBytes, seqToIv };
//# sourceMappingURL=aes-e22cff91.js.map
