import type { Game } from "@bigbud/shared/games";
import { resolveWsHttpOrigin } from "~/rpc/wsHttpOrigin";

export interface GameMetadata {
  title: string;
  description: string;
  faviconUrl: string | null;
}

const cache = new Map<string, Promise<GameMetadata>>();

export function gameFallback(game: Game): GameMetadata {
  return {
    title: game.name,
    description: game.description,
    faviconUrl: `${new URL(game.url).origin}/favicon.ico`,
  };
}

/** Coalesces requests during this app-open session; no metadata is persisted. */
export function loadGameMetadata(game: Game): Promise<GameMetadata> {
  const cached = cache.get(game.url);
  if (cached) return cached;
  const promise = fetch(
    `${resolveWsHttpOrigin()}/api/games/metadata?url=${encodeURIComponent(game.url)}`,
    { signal: AbortSignal.timeout(6000), cache: "no-store" },
  )
    .then(async (response) => {
      if (!response.ok) throw new Error(`Metadata request failed: ${response.status}`);
      const data: unknown = await response.json();
      if (!data || typeof data !== "object") throw new Error("Invalid game metadata");
      const metadata = data as Partial<GameMetadata>;
      const fallback = gameFallback(game);
      const icon = metadata.faviconUrl;
      return {
        title:
          typeof metadata.title === "string" && metadata.title ? metadata.title : fallback.title,
        description:
          typeof metadata.description === "string" && metadata.description
            ? metadata.description
            : fallback.description,
        faviconUrl:
          typeof icon === "string" && icon.startsWith(`${new URL(game.url).origin}/`)
            ? icon
            : fallback.faviconUrl,
      };
    })
    .catch(() => gameFallback(game));
  cache.set(game.url, promise);
  return promise;
}
