import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverMobileDevUrl } from "./MobileRemoteControlSettingsSection.discovery";

afterEach(() => vi.unstubAllGlobals());

describe("mobile dev discovery", () => {
  it("reads the actual endpoint from the same-origin discovery service without caching", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ url: "http://localhost:5742/" }));
    vi.stubGlobal("fetch", fetch);
    expect(await discoverMobileDevUrl()).toBe("http://localhost:5742");
    expect(fetch).toHaveBeenCalledWith(
      "/__bigbud/mobile-dev",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it.each([null, {}, { url: null }, { url: "" }, { url: "javascript:alert(1)" }])(
    "treats an unavailable or invalid discovery response as unavailable: %j",
    async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
      expect(await discoverMobileDevUrl()).toBeNull();
    },
  );

  it("does not retain a URL after the listener stops or discovery fails", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ url: "http://localhost:5741" }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetch);
    expect(await discoverMobileDevUrl()).toBe("http://localhost:5741");
    expect(await discoverMobileDevUrl()).toBeNull();
    expect(await discoverMobileDevUrl()).toBeNull();
  });
});
