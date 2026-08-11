import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { PluginCatalog } from "@bigbud/contracts";

import { runRpc } from "~/rpc/client";
import { toastManager } from "../ui/toast";

export function getPluginUpdateNames(catalog: PluginCatalog): string[] {
  return catalog.installed.flatMap((installation) => {
    const item = catalog.items.find((candidate) => candidate.id === installation.pluginId);
    return item && item.commit !== installation.revision ? [item.presentation.displayName] : [];
  });
}

export function PluginUpdateToastCoordinator() {
  const checked = useRef(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    let cancelled = false;

    void runRpc((client) => client("plugins.refreshCatalog", undefined))
      .then((catalog) => {
        if (cancelled) return;
        const names = getPluginUpdateNames(catalog);
        if (names.length === 0) return;
        toastManager.add({
          type: "info",
          title:
            names.length > 3
              ? "More than 3 plugins have updates"
              : `${names.join(", ")} ${names.length === 1 ? "has" : "have"} an update`,
          description: "Visit the Plugin store to update them.",
          actionProps: {
            children: "Open Plugins",
            onClick: () => void navigate({ to: "/plugins" }),
          },
        });
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [navigate]);

  return null;
}
