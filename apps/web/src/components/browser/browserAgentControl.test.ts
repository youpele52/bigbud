import { describe, expect, it, vi } from "vitest";

import { executeBrowserTabActionWhenReady } from "./browserAgentControl";

describe("executeBrowserTabActionWhenReady", () => {
  it("retries the initial visible-browser action until its viewport is ready", async () => {
    const execute = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("The visible browser tab is not ready."))
      .mockResolvedValueOnce("navigated");

    await expect(executeBrowserTabActionWhenReady(execute)).resolves.toBe("navigated");

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("waits until the visible browser reports the requested page", async () => {
    const execute = vi
      .fn<() => Promise<{ url: string }>>()
      .mockResolvedValueOnce({ url: "https://previous.example" })
      .mockResolvedValueOnce({ url: "https://example.com" });

    await expect(
      executeBrowserTabActionWhenReady(execute, (result) => result.url === "https://example.com"),
    ).resolves.toEqual({ url: "https://example.com" });

    expect(execute).toHaveBeenCalledTimes(2);
  });
});
