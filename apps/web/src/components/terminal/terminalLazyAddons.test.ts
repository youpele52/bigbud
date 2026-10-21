import { describe, expect, it, vi } from "vitest";
import { buildInlineImageAddonOptions, createLazyAddonLoader } from "./terminalLazyAddons";

describe("createLazyAddonLoader", () => {
  it("memoizes a successful load and shares an in-flight one", async () => {
    const load = vi.fn(async () => "addon");
    const loader = createLazyAddonLoader(load, "test");
    const [first, second] = await Promise.all([loader.load(), loader.load()]);
    expect([first, second, await loader.load()]).toEqual(["addon", "addon", "addon"]);
    expect(load).toHaveBeenCalledOnce();
  });

  it("retries a failed load a bounded number of times", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const load = vi.fn(async () => {
      throw new Error("chunk missing");
    });
    const loader = createLazyAddonLoader(load, "test");
    for (let attempt = 0; attempt < 5; attempt++) expect(await loader.load()).toBeNull();
    expect(load).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it("bounds every image protocol and answers size reports", () => {
    expect(buildInlineImageAddonOptions()).toMatchObject({
      enableSizeReports: true,
      storageLimit: 32,
      sixelSizeLimit: 8 * 1024 * 1024,
      iipSizeLimit: 8 * 1024 * 1024,
      kittySizeLimit: 8 * 1024 * 1024,
    });
  });
});
