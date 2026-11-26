import type { ProjectId } from "@bigbud/contracts/core/baseSchemas";
import { useState, type ReactNode } from "react";

import { useProjectReadiness } from "../../../hooks/useProjectReadiness";
import { BigbudLoader } from "../../layout/BigbudLoader";
import { Button } from "../../ui/button";

interface LastReadyChildren {
  projectId: ProjectId | undefined;
  children: ReactNode;
}

export function ThreadProjectGate({
  projectId,
  children,
}: {
  projectId: ProjectId | undefined;
  children: ReactNode;
}) {
  const { project, error, retry } = useProjectReadiness(projectId);
  // Local draft routes already resolve their project before creation.
  const ready = projectId === undefined || project !== undefined;
  // The last ready subtree stays mounted (hidden, inert) while another project loads, so a
  // thread switch does not unmount ChatView and dispose every hidden terminal drawer.
  const [lastReady, setLastReady] = useState<LastReadyChildren | null>(() =>
    ready ? { projectId, children } : null,
  );
  if (ready && (lastReady?.projectId !== projectId || lastReady?.children !== children)) {
    setLastReady({ projectId, children });
  }
  const content =
    ready || lastReady?.projectId === projectId ? children : (lastReady?.children ?? null);

  return (
    <>
      {!ready ? (
        error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <p role="alert" className="max-w-sm text-sm text-destructive">
              {error}
            </p>
            <p className="text-xs text-muted-foreground">Your unsent draft is safe.</p>
            <Button variant="outline" size="sm" onClick={retry}>
              Retry loading project
            </Button>
          </div>
        ) : (
          <BigbudLoader label="Loading chat project" />
        )
      ) : null}
      {/* Keep an existing composer mounted during recovery, including its local draft state. */}
      <div className={ready ? "contents" : "hidden"} hidden={!ready} inert={!ready}>
        {content}
      </div>
    </>
  );
}
