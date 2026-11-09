import type { ProjectId } from "@bigbud/contracts/core/baseSchemas";
import type { GetStartupProjectCatalogResult } from "@bigbud/contracts/orchestration/orchestration.catalog";
import type { NativeApi } from "@bigbud/contracts/server/ipc.nativeApi.ts";

import type { Project } from "../models/types";
import { getWsConnectionStatus } from "../rpc/wsConnectionState";
import { useStore } from "../stores/main";

export const PROJECT_READ_TIMEOUT_MS = 10_000;

/** Connection attempts fence reads even when the NativeApi singleton survives a restart. */
export function projectReadGeneration(): string {
  const connection = getWsConnectionStatus();
  const catalog = useStore.getState().projectCatalogGenerationByScope;
  return JSON.stringify([
    connection.attemptCount,
    connection.phase,
    connection.connectedAt,
    connection.socketUrl,
    catalog.local,
    catalog.remote,
  ]);
}

interface PendingLoad {
  generation: string;
  promise: Promise<Project | undefined>;
  retire: () => void;
}
type MergePage = (page: GetStartupProjectCatalogResult) => void;
const pendingLoads = new WeakMap<object, WeakMap<MergePage, Map<ProjectId, PendingLoad>>>();

/** Resolve an omitted dependency, independently of either scope's catalog pagination. */
export async function loadProjectById(input: {
  api: { orchestration: Pick<NativeApi["orchestration"], "getStartupProjectCatalog"> };
  projectId: ProjectId;
  getProject: () => Project | undefined;
  mergeProjectCatalogPage: MergePage;
  fresh?: boolean;
  timeoutMs?: number;
}): Promise<Project | undefined> {
  const existing = input.getProject();
  if (existing) return existing;
  let stores = pendingLoads.get(input.api);
  if (!stores) pendingLoads.set(input.api, (stores = new WeakMap()));
  let loads = stores.get(input.mergeProjectCatalogPage);
  if (!loads) stores.set(input.mergeProjectCatalogPage, (loads = new Map()));
  const generation = projectReadGeneration();
  const previous = loads.get(input.projectId);
  if (previous && !input.fresh && previous.generation === generation) return previous.promise;
  previous?.retire();

  let retire!: () => void;
  const operation: PendingLoad = {
    generation,
    promise: new Promise<Project | undefined>((resolve, reject) => {
      let active = true;
      let remaining = 2;
      const failures: unknown[] = [];
      const finish = (project: Project | undefined, error?: unknown) => {
        if (!active) return;
        active = false;
        clearTimeout(timer);
        if (error !== undefined) reject(error);
        else resolve(project);
      };
      const timer = setTimeout(
        () => finish(undefined, new Error("Project loading timed out. Retry to reconnect.")),
        input.timeoutMs ?? PROJECT_READ_TIMEOUT_MS,
      );
      retire = () => finish(undefined, new Error("Project loading was superseded. Retry loading."));
      for (const scope of ["local", "remote"] as const) {
        void Promise.resolve()
          .then(() =>
            input.api.orchestration.getStartupProjectCatalog({
              scope,
              limit: 1,
              priorityProjectId: input.projectId,
            }),
          )
          .then((page) => {
            if (!active) return;
            if (generation !== projectReadGeneration()) {
              retire();
              return;
            }
            if (page.projects.some((project) => project.id === input.projectId)) {
              input.mergeProjectCatalogPage(page);
              const project = input.getProject();
              if (project) finish(project);
            }
          })
          .catch((error: unknown) => {
            failures.push(error);
          })
          .finally(() => {
            remaining -= 1;
            if (remaining === 0) finish(undefined, failures[0]);
          });
      }
    }),
    retire: () => retire(),
  };
  loads.set(input.projectId, operation);
  try {
    return await operation.promise;
  } finally {
    if (loads.get(input.projectId) === operation) loads.delete(input.projectId);
  }
}
