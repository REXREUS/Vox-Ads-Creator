/**
 * AES-256-GCM encryption helpers for BYOK key storage.
 * Key derivation: PBKDF2(BOT_SECRET + userId) → 256-bit key
 * Each encrypt call generates a fresh random IV and salt.
 */

import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LEN = 32;       // 256 bits
const IV_LEN = 12;        // 96-bit IV recommended for GCM
const SALT_LEN = 16;
const TAG_LEN = 16;
const PBKDF2_ITER = 100_000;
const PBKDF2_DIGEST = 'sha256';

/**
 * Derive a 256-bit key from BOT_SECRET + userId using PBKDF2.
 * @param {string} userId - Discord User ID (used as salt component)
 * @param {Buffer} salt   - Random salt bytes
 * @returns {Buffer}
 */
function deriveKey(userId, salt) {
  const secret = process.env.BOT_SECRET;
  if (!secret) throw new Error('BOT_SECRET environment variable is not set');

  // Combine BOT_SECRET with userId so keys are user-scoped
  const password = `${secret}:${userId}`;
  return pbkdf2Sync(password, salt, PBKDF2_ITER, KEY_LEN, PBKDF2_DIGEST);
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * @param {string} text   - Plaintext to encrypt
 * @param {string} userId - Discord User ID (scopes the derived key)
 * @returns {string} Base64-encoded string: salt(16) + iv(12) + tag(16) + ciphertext
 */
export function encrypt(text, userId) {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(userId, salt);

  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LEN });
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Pack: salt | iv | tag | ciphertext → base64
  return Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
}

/**
 * Decrypt a ciphertext produced by `encrypt`.
 * @param {string} ciphertext - Base64-encoded payload from `encrypt`
 * @param {string} userId     - Discord User ID (must match the one used during encrypt)
 * @returns {string} Decrypted plaintext
 */
export function decrypt(ciphertext, userId) {
  const buf = Buffer.from(ciphertext, 'base64');

  // Unpack: salt | iv | tag | ciphertext
  const salt = buf.subarray(0, SALT_LEN);
  const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag = buf.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
  const encrypted = buf.subarray(SALT_LEN + IV_LEN + TAG_LEN);

  const key = deriveKey(userId, salt);

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);

  return decipher.update(encrypted) + decipher.final('utf8');
}
