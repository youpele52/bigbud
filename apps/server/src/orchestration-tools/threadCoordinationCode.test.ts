import { describe, expect, it } from "vitest";

import { generateThreadCoordinationCode } from "./threadCoordinationCode.ts";

describe("generateThreadCoordinationCode", () => {
  it("encodes 5 random bytes as BB- plus 8 base32 characters", () => {
    expect(generateThreadCoordinationCode(new Uint8Array([0, 0, 0, 0, 0]))).toBe("BB-AAAAAAAA");
    expect(generateThreadCoordinationCode(new Uint8Array([255, 255, 255, 255, 255]))).toBe(
      "BB-77777777",
    );
    for (let index = 0; index < 50; index += 1) {
      expect(generateThreadCoordinationCode()).toMatch(/^BB-[A-Z2-7]{8}$/);
    }
  });
});
