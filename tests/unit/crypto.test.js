/**
 * Unit tests for src/utils/crypto.js
 * Requirements: 1.2, 15.2
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { encrypt, decrypt } from '../../src/utils/crypto.js';

beforeAll(() => {
  process.env.BOT_SECRET = 'test-secret-key-for-unit-tests-only-32chars!!';
});

describe('encrypt / decrypt', () => {
  it('decrypts back to the original plaintext', () => {
    const userId = '111222333444555666';
    const plaintext = 'my-gemini-api-key:my-runway-api-key';

    const ciphertext = encrypt(plaintext, userId);
    expect(decrypt(ciphertext, userId)).toBe(plaintext);
  });

  it('produces different ciphertext on each call (random IV + salt)', () => {
    const userId = '111222333444555666';
    const plaintext = 'same-plaintext';

    const c1 = encrypt(plaintext, userId);
    const c2 = encrypt(plaintext, userId);

    expect(c1).not.toBe(c2);
    // Both still decrypt correctly
    expect(decrypt(c1, userId)).toBe(plaintext);
    expect(decrypt(c2, userId)).toBe(plaintext);
  });

  it('throws when decrypting with a different userId (cross-user isolation)', () => {
    const userA = '111111111111111111';
    const userB = '999999999999999999';
    const plaintext = 'secret-api-key';

    const ciphertext = encrypt(plaintext, userA);

    expect(() => decrypt(ciphertext, userB)).toThrow();
  });

  it('throws when ciphertext is tampered', () => {
    const userId = '111222333444555666';
    const ciphertext = encrypt('data', userId);

    // Flip a byte in the middle of the payload
    const buf = Buffer.from(ciphertext, 'base64');
    buf[buf.length - 1] ^= 0xff;
    const tampered = buf.toString('base64');

    expect(() => decrypt(tampered, userId)).toThrow();
  });

  it('throws when BOT_SECRET is missing', () => {
    const saved = process.env.BOT_SECRET;
    delete process.env.BOT_SECRET;

    expect(() => encrypt('data', '123')).toThrow('BOT_SECRET');

    process.env.BOT_SECRET = saved;
  });
});
