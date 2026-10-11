import { pageLength } from "./checkpoint.extension.page-custody.mjs";
// Streaming SHA-256 over pages, with only a 64-byte block and 64-word schedule.
// Integrity/provenance is not authentication of an attacker-controlled envelope.
const constants = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotate = (value, count) => (value >>> count) | (value << (32 - count));
export function digestPages(pages) {
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const block = new Uint8Array(64);
  const words = new Uint32Array(64);
  let position = 0,
    length = 0;
  function compress() {
    for (let i = 0; i < 16; i++)
      words[i] =
        (block[i * 4] << 24) |
        (block[i * 4 + 1] << 16) |
        (block[i * 4 + 2] << 8) |
        block[i * 4 + 3];
    for (let i = 16; i < 64; i++) {
      const a = words[i - 15],
        b = words[i - 2];
      words[i] =
        words[i - 16] +
        (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) +
        words[i - 7] +
        (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10));
    }
    let a = state[0],
      b = state[1],
      c = state[2],
      d = state[3],
      e = state[4],
      f = state[5],
      g = state[6],
      h = state[7];
    for (let i = 0; i < 64; i++) {
      const first =
        (h +
          (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
          ((e & f) ^ (~e & g)) +
          constants[i] +
          words[i]) |
        0;
      const second =
        ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + first) | 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) | 0;
    }
    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
    state[4] += e;
    state[5] += f;
    state[6] += g;
    state[7] += h;
  }
  function put(value) {
    block[position++] = value;
    if (position === 64) {
      compress();
      position = 0;
    }
  }
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    const size = pageLength(page);
    length += size;
    for (let offset = 0; offset < size; offset++) put(page[offset]);
  }
  put(0x80);
  while (position !== 56) put(0);
  const bits = length * 8;
  for (let shift = 7; shift >= 0; shift--) put(Math.floor(bits / 2 ** (shift * 8)) & 255);
  return Array.from(state, (word) => word.toString(16).padStart(8, "0")).join("");
}
