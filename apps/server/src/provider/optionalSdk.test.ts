import { describe, expect, it, vi } from "vitest";

import { makeOptionalSdk, OptionalSdkUnavailableError } from "./optionalSdk.ts";

describe("makeOptionalSdk", () => {
  it("loads once, shares the pending load and serves sync access afterwards", async () => {
    const importer = vi.fn(async () => ({ value: 1 }));
    const sdk = makeOptionalSdk("example-sdk", importer);
    expect(() => sdk.loaded()).toThrow("before it was loaded");
    const [first, second] = await Promise.all([sdk.load(), sdk.load()]);
    expect(first).toBe(second);
    expect(sdk.loaded()).toBe(first);
    await sdk.load();
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("reports a missing package as a typed error and retries on the next load", async () => {
    const importer = vi
      .fn<() => Promise<{ value: number }>>()
      .mockRejectedValueOnce(new Error("Cannot find package"))
      .mockResolvedValueOnce({ value: 2 });
    const sdk = makeOptionalSdk("example-sdk", importer);
    const failure = await sdk.load().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OptionalSdkUnavailableError);
    expect((failure as OptionalSdkUnavailableError).packageName).toBe("example-sdk");
    expect(() => sdk.loaded()).toThrow(OptionalSdkUnavailableError);
    expect(await sdk.load()).toEqual({ value: 2 });
    expect(sdk.loaded()).toEqual({ value: 2 });
  });
});
