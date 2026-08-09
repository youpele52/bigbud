import { useEffect, useRef, useState } from "react";
import type { PluginCatalog, PluginCatalogItem } from "@bigbud/contracts";

import { toastManager } from "~/components/ui/toast";
import { runRpc } from "~/rpc/client";
import { ContentPanelHeaderBar } from "../layout/ContentPanelHeaderBar";
import { StandaloneChatPageShell } from "../standalone/StandaloneChatPageShell";
import { StandalonePageContent } from "../standalone/StandalonePageContent";
import { Button } from "../ui/button";
import { PluginCatalogRow } from "./PluginCatalogRow";
import { PluginSearch } from "./PluginSearch";
import { groupPluginsByCategory, matchesPlugin } from "./PluginStorePage.logic";

export const PLUGIN_CATEGORY_GRID_CLASS = "grid grid-cols-1 gap-x-12 md:grid-cols-2";

function syncNotice(catalog: PluginCatalog | undefined): string | undefined {
  if (catalog?.sync.status === "stale")
    return "Showing a cached catalog while refresh is unavailable.";
  if (catalog?.sync.status === "unavailable") return "Plugin catalog is currently unavailable.";
  return undefined;
}

export function PluginStorePage() {
  const [catalog, setCatalog] = useState<PluginCatalog>();
  const [query, setQuery] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [installingIds, setInstallingIds] = useState<ReadonlySet<string>>(new Set());
  const installingIdsRef = useRef<ReadonlySet<string>>(new Set());
  const refresh = async () => {
    setIsRefreshing(true);
    try {
      setCatalog(await runRpc((client) => client("plugins.refreshCatalog", undefined)));
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not refresh plugins",
        description: String(error),
      });
    } finally {
      setIsRefreshing(false);
    }
  };
  const install = async (item: PluginCatalogItem) => {
    if (
      installingIdsRef.current.has(item.id) ||
      catalog?.installed.some((entry) => entry.pluginId === item.id)
    )
      return;
    const nextInstalling = new Set(installingIdsRef.current).add(item.id);
    installingIdsRef.current = nextInstalling;
    setInstallingIds(nextInstalling);
    try {
      setCatalog(
        await runRpc((client) =>
          client("plugins.install", { pluginId: item.id, revision: item.commit }),
        ),
      );
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not install plugin",
        description: String(error),
      });
    } finally {
      const next = new Set(installingIdsRef.current);
      next.delete(item.id);
      installingIdsRef.current = next;
      setInstallingIds(next);
    }
  };
  useEffect(() => {
    void runRpc((client) => client("plugins.listCatalog", undefined))
      .then(setCatalog)
      .catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: "Could not load plugins",
          description: String(error),
        }),
      );
  }, []);
  const items = (catalog?.items ?? []).filter((item) => matchesPlugin(item, query));
  const categories = groupPluginsByCategory(items);
  const notice = syncNotice(catalog);
  return (
    <StandaloneChatPageShell
      header={
        <ContentPanelHeaderBar
          title={<h2 className="shrink-0 text-sm font-medium text-foreground">Plugins</h2>}
          center={<PluginSearch query={query} onQueryChange={setQuery} />}
          actions={
            <Button
              size="sm"
              variant="ghost"
              disabled={isRefreshing}
              onClick={() => void refresh()}
            >
              {isRefreshing ? "Refreshing…" : "Refresh"}
            </Button>
          }
        />
      }
    >
      <StandalonePageContent>
        <main>
          {notice ? <p className="mb-6 text-xs text-muted-foreground">{notice}</p> : null}
          {categories.length > 0 ? (
            <div className="space-y-10">
              {categories.map(([category, categoryItems]) => (
                <section key={category} aria-label={`${category} plugins`}>
                  <h2 className="border-b border-border/70 pb-2 text-sm font-medium text-foreground">
                    {category}
                  </h2>
                  <div className={PLUGIN_CATEGORY_GRID_CLASS}>
                    {categoryItems.map((item) => (
                      <PluginCatalogRow
                        key={item.id}
                        item={item}
                        installation={catalog?.installed.find(
                          (entry) => entry.pluginId === item.id,
                        )}
                        isInstalling={installingIds.has(item.id)}
                        onInstall={(candidate) => void install(candidate)}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : catalog ? (
            <p className="py-6 text-sm text-muted-foreground">No plugins found.</p>
          ) : null}
        </main>
      </StandalonePageContent>
    </StandaloneChatPageShell>
  );
}
