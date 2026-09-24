import { describe, expect, it, vi } from "vitest";
import { fetchGameMetadata, parseGameMetadata } from "./http.games.metadata.ts";

const url = "https://playsnake.org/";

describe("game metadata", () => {
  it("extracts safe title, description and favicon", () => {
    expect(
      parseGameMetadata(
        '<title>Snake &amp; friends</title><meta name="description" content="Play &amp; enjoy"><link rel="icon" href="/icon.png">',
        url,
      ),
    ).toEqual({
      title: "Snake & friends",
      description: "Play & enjoy",
      faviconUrl: "https://playsnake.org/icon.png",
    });
    expect(
      parseGameMetadata('<link rel="icon" href="https://elsewhere.test/icon.png">', url).faviconUrl,
    ).toBe("https://playsnake.org/favicon.ico");
  });

  it("rejects cross-origin redirects and oversized responses", async () => {
    const redirect = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { Location: "https://elsewhere.test/" } }),
      );
    await expect(fetchGameMetadata(url, redirect)).rejects.toThrow("Untrusted redirect");
    expect(redirect).toHaveBeenCalledTimes(1);
    await expect(
      fetchGameMetadata(
        url,
        vi.fn().mockResolvedValue(new Response("hi", { headers: { "Content-Type": "image/png" } })),
      ),
    ).rejects.toThrow("No HTML metadata");
  });
});
