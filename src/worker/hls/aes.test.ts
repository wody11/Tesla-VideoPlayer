import { decryptAes128CbcPkcs7, seqToIv } from './aes';

describe('HLS AES-128 decryption', () => {
  test('does not strip plaintext bytes that merely resemble PKCS#7 padding', async () => {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) throw new Error('WebCrypto is required for this test.');

    const keyBytes = new Uint8Array(16).map((_, index) => index + 1);
    const iv = seqToIv(42);
    const plaintext = new Uint8Array([0x47, 0x40, 0x00, 0x10, 0x02, 0x02]);
    const key = await subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt']);
    const encrypted = await subtle.encrypt(
      { name: 'AES-CBC', iv: Uint8Array.from(iv) },
      key,
      Uint8Array.from(plaintext)
    );

    const decrypted = await decryptAes128CbcPkcs7(encrypted, keyBytes, iv);

    expect(Array.from(new Uint8Array(decrypted))).toEqual(Array.from(plaintext));
  });
});
