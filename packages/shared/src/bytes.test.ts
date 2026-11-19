import { describe, expect, it } from "vitest";
import { formatBytes } from "./bytes";

describe("formatBytes", () => {
  it("uses binary units with two decimals", () => {
    expect(formatBytes(512)).toBe("512.00 B");
    expect(formatBytes(1536)).toBe("1.50 KiB");
    expect(formatBytes(25 * 1024 * 1024)).toBe("25.00 MiB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.00 GiB");
    expect(formatBytes(2 * 1024 ** 5)).toBe("2048.00 TiB");
  });

  it("shows unknown values as a dash", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});
