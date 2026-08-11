import { Link } from "@tanstack/react-router";
import type { PluginCatalogItem, PluginInstallation } from "@bigbud/contracts";

import { Button } from "../ui/button";
import { PluginArtwork } from "./PluginArtwork";

interface PluginCatalogRowProps {
  readonly item: PluginCatalogItem;
  readonly installation: PluginInstallation | undefined;
  readonly isInstalling: boolean;
  readonly onInstall: (item: PluginCatalogItem) => void;
}

export function PluginCatalogRow({
  installation,
  isInstalling,
  item,
  onInstall,
}: PluginCatalogRowProps) {
  return (
    <div className="flex min-h-[76px] min-w-0 items-center gap-3 border-b py-3">
      <Link
        to="/plugins/$pluginId"
        params={{ pluginId: item.id }}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <PluginArtwork
          plugin={item}
          surface="store"
          className="size-12 shrink-0 rounded-lg object-contain"
        />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">
            {item.presentation.displayName}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {item.presentation.shortDescription ?? item.presentation.developer ?? item.name}
          </span>
        </span>
      </Link>
      {installation ? (
        <span className="shrink-0 text-xs text-muted-foreground">Installed</span>
      ) : (
        <Button
          size="xs"
          variant="outline"
          disabled={isInstalling}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onInstall(item);
          }}
        >
          {isInstalling ? "Installing…" : "Install"}
        </Button>
      )}
    </div>
  );
}
