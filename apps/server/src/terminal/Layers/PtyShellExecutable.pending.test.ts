import { describe, expect, it, vi } from "vitest";
import { makeBoundedShellFileCheck } from "./PtyShellExecutable.pending";

describe("bounded shell filesystem preflight", () => {
  it("shares a stalled check and skips different paths instead of consuming more filesystem workers", async () => {
    let resolve!: (answer: boolean) => void;
    const check = vi.fn(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    const bounded = makeBoundedShellFileCheck(check);
    const first = bounded("/stalled/shell");
    await Promise.resolve();
    expect(bounded("/stalled/shell")).toBe(first);
    expect(await bounded("/another/stalled/shell")).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
    resolve(false);
    expect(await first).toBe(false);
    await Promise.resolve();
    const next = bounded("/another/stalled/shell");
    await Promise.resolve();
    expect(check).toHaveBeenCalledTimes(2);
    resolve(true);
    expect(await next).toBe(true);
  });
});
