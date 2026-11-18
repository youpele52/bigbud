import { describe, expect, it } from "vitest";
import { terminalPtyBackend } from "./PTY.backend";

describe("terminal PTY backend selection", () => {
  it.each([true, false])("uses node-pty on Windows with Bun=%s", (hasBun) => {
    expect(terminalPtyBackend("win32", hasBun)).toBe("node");
  });

  it.each(["darwin", "linux"] as const)("preserves runtime selection on %s", (platform) => {
    expect(terminalPtyBackend(platform, true)).toBe("bun");
    expect(terminalPtyBackend(platform, false)).toBe("node");
  });
});
