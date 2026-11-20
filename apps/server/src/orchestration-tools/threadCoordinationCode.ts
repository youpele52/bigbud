/**
 * Random reference codes for cross-project confirmation challenges. Shared by the grants layer
 * and the fail-closed confirmation path.
 *
 * @module threadCoordinationCode
 */
import { randomBytes } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** `BB-` plus 8 base32 characters: exactly the 40 bits of 5 random bytes. */
export function generateThreadCoordinationCode(bytes: Uint8Array = randomBytes(5)): string {
  let bits = 0;
  let value = 0;
  let code = "";
  for (const byte of bytes.subarray(0, 5)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      code += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
      value &= (1 << bits) - 1; // Keep only unread bits so the buffer never exceeds 32 bits.
    }
  }
  return `BB-${code}`;
}
