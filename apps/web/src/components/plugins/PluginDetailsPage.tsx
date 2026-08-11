import type { PluginCatalogItem, PluginInstallation } from "@bigbud/contracts";
import { Link, useParams } from "@tanstack/react-router";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { runRpc } from "~/rpc/client";
import { toastManager } from "~/components/ui/toast";
import { ContentPanelHeaderBar } from "../layout/ContentPanelHeaderBar";
import { StandaloneChatPageShell } from "../standalone/StandaloneChatPageShell";
import { StandalonePageContent } from "../standalone/StandalonePageContent";
import { Button } from "../ui/button";
import { PluginArtwork } from "./PluginArtwork";
import {
  pluginDetailAction,
  pluginDetailActionLabel,
  pluginDetailActionRequiresConfirmation,
  pluginDetailMutationErrorTitle,
  pluginErrorDescription,
} from "./PluginDetailsPage.logic";

interface PluginDetail {
  readonly item: PluginCatalogItem;
  readonly installation: PluginInstallation | undefined;
}

export function PluginDetailsPage() {
  const { pluginId } = useParams({ from: "/_chat/plugins/$pluginId" });
  const [detail, setDetail] = useState<PluginDetail>();
  const [loadError, setLoadError] = useState<string>();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [isMutating, setIsMutating] = useState(false);

  useEffect(() => {
    let active = true;
    setDetail(undefined);
    setLoadError(undefined);
    void runRpc((client) => client("plugins.get", { pluginId }))
      .then((value) => {
        if (!active) return;
        setDetail({
          item: value.item,
          installation: value.installation as PluginInstallation | undefined,
        });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const description = pluginErrorDescription(error);
        setLoadError(description);
        toastManager.add({
          type: "error",
          title: "Could not load plugin",
          description,
        });
      });
    return () => {
      active = false;
    };
  }, [loadAttempt, pluginId]);

  const item = detail?.item;
  const installation = detail?.installation;
  const action = item ? pluginDetailAction(item.commit, installation) : undefined;

  const mutate = async () => {
    if (!item || !action) return;
    if (
      pluginDetailActionRequiresConfirmation(action) &&
      !window.confirm(
        `Uninstall ${item.presentation.displayName}? New conversations will no longer have its skills. Existing work may finish.`,
      )
    )
      return;
    setIsMutating(true);
    try {
      const next =
        action === "update" && installation
          ? await runRpc((client) =>
              client("plugins.update", {
                pluginId,
                revision: installation.revision,
                targetRevision: item.commit,
              }),
            )
          : action === "uninstall" && installation
            ? await runRpc((client) =>
                client("plugins.uninstall", { pluginId, revision: installation.revision }),
              )
            : await runRpc((client) =>
                client("plugins.install", { pluginId, revision: item.commit }),
              );
      setDetail({
        item,
        installation: next.installed.find((entry) => entry.pluginId === pluginId),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: pluginDetailMutationErrorTitle(action),
        description: pluginErrorDescription(error),
      });
    } finally {
      setIsMutating(false);
    }
  };

  return (
    <StandaloneChatPageShell
      header={
        <ContentPanelHeaderBar
          title={
            <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
              <Link
                className="shrink-0 text-foreground transition-colors hover:text-foreground/80"
                to="/plugins"
              >
                Plugins
              </Link>
              <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
              <span className="truncate text-muted-foreground">
                {item?.presentation.displayName ?? pluginId}
              </span>
            </div>
          }
        />
      }
    >
      <StandalonePageContent>
        <main>
          {loadError ? (
            <div role="alert" className="space-y-3">
              <div>
                <p className="text-sm font-medium">Could not load plugin</p>
                <p className="mt-1 text-xs text-muted-foreground">{loadError}</p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setLoadAttempt((value) => value + 1)}
              >
                Retry
              </Button>
            </div>
          ) : !item ? (
            <p className="text-sm text-muted-foreground">Loading plugin…</p>
          ) : (
            <>
              <header className="flex flex-col gap-8 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-5">
                  <PluginArtwork
                    plugin={item}
                    scope={installation ? "installed" : "catalog"}
                    {...(installation ? { revision: installation.revision } : {})}
                    surface="store"
                    className="size-20 shrink-0 rounded-2xl object-contain"
                  />
                  <div className="min-w-0">
                    <h1 className="text-base font-semibold tracking-tight">
                      {item.presentation.displayName}
                    </h1>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {item.presentation.shortDescription ?? "Extend bigbud with new capabilities"}
                    </p>
                  </div>
                </div>
                <Button
                  className="self-start rounded-full px-5 text-xs font-normal sm:self-auto"
                  size="sm"
                  disabled={isMutating}
                  onClick={() => void mutate()}
                >
                  <PlusIcon />
                  {isMutating
                    ? "Working…"
                    : action
                      ? pluginDetailActionLabel(action)
                      : "Install plugin"}
                </Button>
              </header>

              {item.presentation.longDescription ? (
                <p className="mt-12 max-w-4xl text-sm leading-5 text-muted-foreground">
                  {item.presentation.longDescription}
                </p>
              ) : null}

              {item.presentation.defaultPrompt ? (
                <section className="mt-12 rounded-2xl border border-border/70 bg-muted/30 p-5">
                  <h2 className="font-medium">Try an example</h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {item.presentation.defaultPrompt}
                  </p>
                  <p className="mt-3 text-xs text-muted-foreground">
                    {installation
                      ? `Start a new chat with @plugin::${item.name} and this prompt.`
                      : "Install this plugin to use its example."}
                  </p>
                </section>
              ) : null}

              <section className="mt-14">
                <h2 className="border-b border-border/70 pb-4 text-sm font-medium">
                  Skills <span className="text-muted-foreground">{item.components.length}</span>
                </h2>
                <div className="divide-y divide-border/60">
                  {item.components.map((component) => (
                    <div key={component.path} className="py-5">
                      <div className="text-sm font-medium">
                        {component.displayName ?? component.name}
                      </div>
                      {component.description ? (
                        <div className="mt-1 text-xs text-muted-foreground">
                          {component.description}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>

              <section className="mt-12">
                <h2 className="border-b border-border/70 pb-4 text-sm font-medium">Information</h2>
                <dl className="grid grid-cols-[minmax(8rem,15rem)_1fr] gap-y-4 py-5 text-sm">
                  <dt className="text-muted-foreground">Developer</dt>
                  <dd>{item.presentation.developer ?? "Unknown"}</dd>
                  <dt className="text-muted-foreground">Category</dt>
                  <dd>{item.presentation.category ?? "Uncategorized"}</dd>
                  <dt className="text-muted-foreground">Version</dt>
                  <dd>{item.version ?? item.commit}</dd>
                  <dt className="text-muted-foreground">Source commit</dt>
                  <dd className="break-all text-muted-foreground">{item.commit}</dd>
                </dl>
              </section>
            </>
          )}
        </main>
      </StandalonePageContent>
    </StandaloneChatPageShell>
  );
}
