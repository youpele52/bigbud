import type { ProjectId } from "@bigbud/contracts/core/baseSchemas";
import { useStore } from "../stores/main";
import { pruneProjectDependencies } from "../stores/main/helpers.projectDependencies.store";

/** Only mounted surfaces retain dependencies; closed threads do not grow a permanent cache. */
export function retainProjectDependency(projectId: ProjectId): () => void {
  const update = (delta: number) =>
    useStore.setState((state) => {
      const counts = { ...state.projectDependencyRefCounts };
      const count = (counts[projectId] ?? 0) + delta;
      if (count > 0) counts[projectId] = count;
      else delete counts[projectId];
      const next = { ...state, projectDependencyRefCounts: counts };
      return delta < 0 ? pruneProjectDependencies(next, projectId) : next;
    });
  update(1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    update(-1);
  };
}
