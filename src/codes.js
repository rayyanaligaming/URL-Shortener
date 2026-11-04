const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// Random base62 using a cryptographically secure source.
// Bytes >= 248 are discarded: 248 = 62 * 4, so b % 62 stays perfectly uniform
// (no modulo bias).
function generateCode(length = 7) {
  let out = '';
  while (out.length < length) {
    const bytes = crypto.randomBytes(length * 2);
    for (const b of bytes) {
      if (b < 248) {
        out += ALPHABET[b % 62];
        if (out.length === length) break;
      }
    }
  }
  return out;
}

module.exports = { generateCode };