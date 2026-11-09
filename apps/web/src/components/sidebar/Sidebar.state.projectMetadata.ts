import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../../stores/main";
import { selectCatalogProjects } from "../../stores/main/helpers.projectDependencies.store";

/** List membership is bounded; metadata also includes retained open-thread dependencies. */
export function useSidebarProjectMetadata() {
  const projects = useStore(useShallow(selectCatalogProjects));
  const metadataProjects = useStore((store) => store.projects);
  const projectCwdById = useMemo(
    () => new Map(metadataProjects.map((project) => [project.id, project.cwd] as const)),
    [metadataProjects],
  );
  return { projects, metadataProjects, projectCwdById };
}
