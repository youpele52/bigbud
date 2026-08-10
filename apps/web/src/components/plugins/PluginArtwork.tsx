import type { PluginAssetKey } from "@bigbud/contracts";
import { PlugIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { resolveWsHttpOrigin } from "~/rpc/wsHttpOrigin";
import {
  nextPluginArtworkAssetIndex,
  pluginArtworkAssetKeys,
  type PluginArtworkSurface,
} from "./PluginArtwork.logic";

export function pluginAssetUrl(input: {
  scope: "catalog" | "installed";
  revision: string;
  pluginId: string;
  assetKey: PluginAssetKey;
}): string {
  const parameters = new URLSearchParams(input);
  return `${resolveWsHttpOrigin()}/api/plugins/assets?${parameters.toString()}`;
}

export function PluginArtwork(props: {
  plugin: {
    id: string;
    commit: string;
    presentation: {
      displayName: string;
      assets: {
        composerIcon?: string | undefined;
        logo?: string | undefined;
        logoDark?: string | undefined;
      };
    };
  };
  scope?: "catalog" | "installed";
  revision?: string;
  surface?: PluginArtworkSurface;
  className?: string;
}) {
  const { resolvedTheme } = useTheme();
  const scope = props.scope ?? "catalog";
  const revision = props.revision ?? props.plugin.commit;
  const surface = props.surface ?? "compact";
  const candidates = useMemo(
    () => pluginArtworkAssetKeys(surface, resolvedTheme, props.plugin.presentation.assets),
    [props.plugin.presentation.assets, resolvedTheme, surface],
  );
  const candidateKey = candidates.join(",");
  const [candidateIndex, setCandidateIndex] = useState(0);
  useEffect(
    () => setCandidateIndex(0),
    [candidateKey, props.plugin.id, revision, resolvedTheme, scope],
  );

  const assetKey = candidates[candidateIndex];
  if (!assetKey) {
    const glyphSize = surface === "store" ? "size-5" : "size-3.5";
    const fallbackPadding = surface === "store" ? "p-3" : "p-1.5";
    return (
      <span
        data-testid="plugin-artwork-fallback"
        className={cn("flex items-center justify-center", props.className ?? "size-7")}
      >
        <span className={cn("flex items-center justify-center", fallbackPadding)}>
          <PlugIcon aria-hidden className={glyphSize} />
        </span>
      </span>
    );
  }
  const src = pluginAssetUrl({ scope, revision, pluginId: props.plugin.id, assetKey });
  return (
    <img
      src={src}
      alt={`${props.plugin.presentation.displayName} icon`}
      className={props.className ?? "size-7 rounded object-contain"}
      loading="lazy"
      onError={() => setCandidateIndex(nextPluginArtworkAssetIndex)}
    />
  );
}
