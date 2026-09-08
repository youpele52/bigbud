import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isForbiddenDirectCleanupRoot } from "./DirectResourceCleanup.roots";

describe("direct cleanup forbidden roots", () => {
  it("rejects filesystem, home, temporary, and system roots without rejecting descendants", () => {
    const home = path.join(path.parse(process.cwd()).root, "test-home");

    expect(isForbiddenDirectCleanupRoot(path.parse(process.cwd()).root, { home })).toBe(true);
    expect(isForbiddenDirectCleanupRoot(home, { home })).toBe(true);
    expect(isForbiddenDirectCleanupRoot(tmpdir(), { home })).toBe(true);

    if (process.platform !== "win32") {
      expect(isForbiddenDirectCleanupRoot("/etc", { home })).toBe(true);
    }
    expect(isForbiddenDirectCleanupRoot(path.join(tmpdir(), "bigbud-safe-root"), { home })).toBe(
      false,
    );
  });
});
