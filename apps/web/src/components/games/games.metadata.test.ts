import { beforeEach, describe, expect, it, vi } from "vitest";
import { GAMES } from "@bigbud/shared/games";

vi.mock("~/rpc/wsHttpOrigin", () => ({ resolveWsHttpOrigin: () => "http://localhost:1234" }));

describe("Games catalog metadata", () => {
  beforeEach(() => vi.resetModules());

  it("keeps all twelve approved destinations exact", () => {
    expect(GAMES.map((game) => game.url)).toEqual([
      "https://www.google.com/logos/2010/pacman10-i.html",
      "https://playsnake.org/",
      "https://tetris.com/play-tetris",
      "https://orteil.dashnet.org/cookieclicker/",
      "https://www.decisionproblem.com/paperclips/",
      "https://adarkroom.doublespeakgames.com/",
      "https://littlealchemy2.com/",
      "https://neal.fun/infinite-craft/",
      "https://skribbl.io/",
      "https://cardgames.io/solitaire/",
      "https://www.crazygames.com/game/word-wipe",
      "https://www.retrogames.cz/",
    ]);
    expect(GAMES.at(-1)).toMatchObject({
      name: "Retro Games",
      category: "Retro Games",
      url: "https://www.retrogames.cz/",
    });
  });

  it("coalesces requests within an app session and refetches after relaunch", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        title: "Live title",
        description: "Live description",
        faviconUrl: "https://playsnake.org/icon.png",
      }),
    });
    vi.stubGlobal("fetch", fetcher);
    const game = GAMES[1];
    const first = await import("./games.metadata");
    expect(await first.loadGameMetadata(game)).toMatchObject({ title: "Live title" });
    await first.loadGameMetadata(game);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toContain(encodeURIComponent(game.url));
    vi.resetModules();
    const relaunched = await import("./games.metadata");
    await relaunched.loadGameMetadata(game);
    expect(fetcher).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("falls back when metadata is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const { loadGameMetadata, gameFallback } = await import("./games.metadata");
    expect(await loadGameMetadata(GAMES[0])).toEqual(gameFallback(GAMES[0]));
    vi.unstubAllGlobals();
  });
});
