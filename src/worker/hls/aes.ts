// HLS AES-128 (CBC) decryption helper using WebCrypto.
export async function decryptAes128CbcPkcs7(
  data: ArrayBuffer | Uint8Array,
  keyBytes: ArrayBuffer | Uint8Array,
  ivBytes: ArrayBuffer | Uint8Array
): Promise<ArrayBuffer> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto SubtleCrypto not available');
  const dataBuf = toArrayBuffer(data);
  const keyBuf = toArrayBuffer(keyBytes);
  const ivBuf = toArrayBuffer(ivBytes);
  const key = await subtle.importKey('raw', keyBuf, { name: 'AES-CBC' }, false, ['decrypt']);

  // WebCrypto AES-CBC already validates and removes PKCS#7 padding. Removing it
  // again corrupts valid MPEG-TS payloads whose final bytes resemble padding.
  return subtle.decrypt({ name: 'AES-CBC', iv: ivBuf }, key, dataBuf);
}

function toArrayBuffer(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  return value instanceof Uint8Array
    ? Uint8Array.from(value).buffer
    : value;
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

export function seqToIv(mediaSequence: number): Uint8Array {
  // HLS: when IV is omitted, use the media sequence as a 16-byte big-endian integer.
  const iv = new Uint8Array(16);
  const view = new DataView(iv.buffer);
  view.setUint32(12, mediaSequence >>> 0);
  return iv;
}
