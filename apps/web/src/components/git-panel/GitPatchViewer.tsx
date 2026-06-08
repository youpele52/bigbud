import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import { useMemo } from "react";

import { useTheme } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import {
  buildFileDiffRenderKey,
  getRenderablePatch,
  resolveFileDiffPath,
} from "../diff/DiffPanel.logic";

interface GitPatchViewerProps {
  emptyLabel: string;
  patch: string;
}

export function GitPatchViewer({ emptyLabel, patch }: GitPatchViewerProps) {
  const { resolvedTheme } = useTheme();
  const renderablePatch = useMemo(
    () => getRenderablePatch(patch, `git-panel:${resolvedTheme}`),
    [patch, resolvedTheme],
  );

  if (!patch.trim()) {
    return <div className="p-3 text-xs text-muted-foreground">{emptyLabel}</div>;
  }

  if (!renderablePatch) {
    return <div className="p-3 text-xs text-muted-foreground">{emptyLabel}</div>;
  }

  if (renderablePatch.kind === "raw") {
    return (
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div className="mb-2 text-xs text-muted-foreground">{renderablePatch.reason}</div>
        <pre className="overflow-x-auto rounded-md border border-border/60 bg-card/30 p-3 text-xs whitespace-pre-wrap text-foreground">
          {renderablePatch.text}
        </pre>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <Virtualizer
        className="grid gap-3"
        config={{
          overscrollSize: 400,
          intersectionObserverMargin: 800,
        }}
      >
        {renderablePatch.files.map((file) => (
          <section key={buildFileDiffRenderKey(file)} className="overflow-hidden">
            <div className="border-b border-border/50 px-1 py-2 text-xs font-medium text-foreground">
              <span>{resolveFileDiffPath(file)}</span>
            </div>
            <FileDiff
              fileDiff={file}
              options={{
                diffStyle: "unified",
                lineDiffType: "none",
                overflow: "scroll",
                theme: resolveDiffThemeName(resolvedTheme),
                themeType: resolvedTheme,
              }}
            />
          </section>
        ))}
      </Virtualizer>
    </div>
  );
}
