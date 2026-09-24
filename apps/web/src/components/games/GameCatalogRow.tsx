import { useEffect, useState } from "react";
import type { Game } from "@bigbud/shared/games";
import { gameFallback, loadGameMetadata, type GameMetadata } from "./games.metadata";

export function GameCatalogRow({ game, onSelect }: { game: Game; onSelect: (game: Game) => void }) {
  const [metadata, setMetadata] = useState<GameMetadata>(() => gameFallback(game));
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    void loadGameMetadata(game).then((result) => {
      if (mounted) setMetadata(result);
    });
    return () => {
      mounted = false;
    };
  }, [game]);
  return (
    <button
      type="button"
      className="flex min-h-[76px] w-full min-w-0 items-center gap-3 rounded-md border-b py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:bg-accent/40"
      onClick={() => onSelect(game)}
    >
      {metadata.faviconUrl && metadata.faviconUrl !== failedIconUrl ? (
        <img
          src={metadata.faviconUrl}
          alt=""
          className="size-12 shrink-0 rounded-lg object-contain"
          onError={() => setFailedIconUrl(metadata.faviconUrl)}
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-muted text-sm"
        >
          🎮
        </span>
      )}
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{metadata.title}</span>
        <span className="block truncate text-xs text-muted-foreground">{metadata.description}</span>
      </span>
    </button>
  );
}
