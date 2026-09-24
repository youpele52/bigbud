import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { GAMES, type Game } from "@bigbud/shared/games";
import { Gamepad2 } from "lucide-react";
import { ContentPanelHeaderBar } from "../layout/ContentPanelHeaderBar";
import { StandaloneChatPageShell } from "../standalone/StandaloneChatPageShell";
import { StandalonePageContent } from "../standalone/StandalonePageContent";
import { useSidebar } from "../ui/sidebar";
import { useUiStateStore } from "~/stores/ui/ui.store";
import { openGameBrowserTab } from "~/stores/browser/gameBrowser.actions";
import { toastManager } from "../ui/toast";
import { GameCatalogRow } from "./GameCatalogRow";

export function GamesPage() {
  const [query, setQuery] = useState("");
  const opening = useRef(false);
  const navigate = useNavigate();
  const { setOpen } = useSidebar();
  const selectGame = async (game: Game) => {
    if (opening.current) return;
    opening.current = true;
    const threadId = useUiStateStore.getState().lastActiveThreadId;
    try {
      if (threadId) await navigate({ to: "/$threadId", params: { threadId } });
      else await navigate({ to: "/" });
      setOpen(false);
      openGameBrowserTab({ name: game.name, url: game.url, onOpened: () => undefined });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not return to chat",
        description: String(error),
      });
    } finally {
      opening.current = false;
    }
  };
  const matches = GAMES.filter((game) =>
    `${game.name} ${game.description} ${game.category}`
      .toLowerCase()
      .includes(query.toLowerCase().trim()),
  );
  const categories = [...new Set(GAMES.map((game) => game.category))];
  return (
    <StandaloneChatPageShell
      header={
        <ContentPanelHeaderBar
          title={
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <Gamepad2 className="size-4" />
              Games
            </h2>
          }
          center={
            <input
              type="search"
              aria-label="Search games"
              placeholder="Search games"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-8 w-full max-w-sm rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        />
      }
    >
      <StandalonePageContent>
        <main className="space-y-10">
          {categories.map((category) => {
            const games = matches.filter((game) => game.category === category);
            return games.length ? (
              <section key={category} aria-label={`${category} games`}>
                <h2 className="border-b border-border/70 pb-2 text-sm font-medium">{category}</h2>
                <div className="grid grid-cols-1 gap-x-12 md:grid-cols-2">
                  {games.map((game) => (
                    <GameCatalogRow
                      key={game.url}
                      game={game}
                      onSelect={(selected) => void selectGame(selected)}
                    />
                  ))}
                </div>
              </section>
            ) : null;
          })}
          {!matches.length && <p className="py-6 text-sm text-muted-foreground">No games found.</p>}
        </main>
      </StandalonePageContent>
    </StandaloneChatPageShell>
  );
}
