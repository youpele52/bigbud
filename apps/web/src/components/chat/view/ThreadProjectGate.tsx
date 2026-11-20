import type { ProjectId } from "@bigbud/contracts/core/baseSchemas";
import { useEffect, useState, type ReactNode } from "react";

import { useProjectReadiness } from "../../../hooks/useProjectReadiness";
import { BigbudLoader } from "../../layout/BigbudLoader";
import { Button } from "../../ui/button";

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
  const [readyProjectId, setReadyProjectId] = useState(ready ? projectId : undefined);
  useEffect(() => {
    if (ready) setReadyProjectId(projectId);
  }, [projectId, ready]);

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
        {ready || readyProjectId === projectId ? children : null}
      </div>
    </>
  );
}
