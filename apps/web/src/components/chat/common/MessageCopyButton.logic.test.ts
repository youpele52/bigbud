import { describe, expect, it, vi } from "vitest";

import { createFullTextPrefetch } from "./MessageCopyButton.logic";

describe("createFullTextPrefetch", () => {
  it("hands a landed prefetch to the click synchronously and reads once", async () => {
    const resolveText = vi.fn(async () => "full text");
    const fullText = createFullTextPrefetch(resolveText);
    await fullText.prefetch();
    await fullText.prefetch();

    expect(fullText.take()).toEqual({ text: "full text" });
    expect(resolveText).toHaveBeenCalledTimes(1);
  });

  it("returns the pending read when nothing was prefetched", async () => {
    const fullText = createFullTextPrefetch(async () => "full text");
    const read = fullText.take();

    expect("promise" in read).toBe(true);
    await expect("promise" in read ? read.promise : null).resolves.toBe("full text");
  });

  it("does not cache a failed read", async () => {
    const resolveText = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce("full text");
    const fullText = createFullTextPrefetch(resolveText);
    await expect(fullText.prefetch()).rejects.toThrow("offline");

    const read = fullText.take();
    await expect("promise" in read ? read.promise : null).resolves.toBe("full text");
    expect(resolveText).toHaveBeenCalledTimes(2);
  });
});
