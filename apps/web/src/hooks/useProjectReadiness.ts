import type { ProjectId } from "@bigbud/contracts/core/baseSchemas";
import { useCallback, useEffect, useRef, useState } from "react";
import { retainProjectDependency } from "../lib/projectDependencies";
import { useWsConnectionStatus } from "../rpc/wsConnectionState";

import { loadProjectById } from "../lib/projectCatalog";
import { readNativeApi } from "../rpc/nativeApi";
import { useStore } from "../stores/main";

/** Re-ensure project metadata whenever a bounded catalog replacement evicts it. */
export function useProjectReadiness(projectId: ProjectId | undefined, enabled = true) {
  const project = useStore((state) => state.projects.find((entry) => entry.id === projectId));
  const [attempt, setAttempt] = useState(0);
  const fresh = useRef(false);
  const connection = useWsConnectionStatus();
  const generation = useStore((state) => state.projectCatalogGenerationByScope);
  useEffect(() => {
    if (enabled && projectId) return retainProjectDependency(projectId);
  }, [enabled, projectId]);
  const [failure, setFailure] = useState<{
    projectId: ProjectId;
    attempt: number;
    message: string;
  } | null>(null);

  useEffect(() => {
    setFailure(null);
    if (!enabled || !projectId || project) return;
    let disposed = false;
    const fail = (message: string) => {
      if (!disposed) setFailure({ projectId, attempt, message });
    };
    const api = readNativeApi();
    if (!api) {
      fail("bigbud is not connected to the server.");
      return;
    }
    void loadProjectById({
      api,
      projectId,
      getProject: () => useStore.getState().projects.find((entry) => entry.id === projectId),
      mergeProjectCatalogPage: useStore.getState().mergeProjectCatalogPage,
      fresh: fresh.current,
    })
      .then((loadedProject) => {
        if (!loadedProject) fail("The selected project is unavailable.");
      })
      .catch((error: unknown) => {
        fail(error instanceof Error ? error.message : "The selected project could not be loaded.");
      });
    fresh.current = false;
    return () => {
      disposed = true;
    };
  }, [
    attempt,
    enabled,
    project,
    projectId,
    generation,
    connection.attemptCount,
    connection.phase,
    connection.connectedAt,
  ]);

  const retry = useCallback(() => {
    fresh.current = true;
    setAttempt((value) => value + 1);
  }, []);
  const error =
    enabled && !project && failure?.projectId === projectId && failure?.attempt === attempt
      ? failure.message
      : null;
  return { project, error, retry };
}
