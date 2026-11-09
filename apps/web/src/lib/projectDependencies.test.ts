import { ProjectId } from "@bigbud/contracts/core/baseSchemas";
import { beforeEach, expect, it } from "vitest";
import { useStore } from "../stores/main";
import { retainProjectDependency } from "./projectDependencies";
import {
  PROJECT_DEPENDENCY_CACHE_LIMIT,
  selectCatalogProjects,
} from "../stores/main/helpers.projectDependencies.store";
import {
  makeEvent,
  makeReadModel,
  makeReadModelThread,
} from "../stores/main/main.store.test.helpers";
import {
  chatsPage,
  emptyPage,
  resetProjectGateStore,
} from "../components/chat/view/ThreadProjectGate.test-helpers";

function page(index: number, scope: "local" | "remote" = "local") {
  return {
    ...chatsPage,
    projects: [
      {
        ...chatsPage.projects[0]!,
        id: ProjectId.makeUnsafe(`dependency-${index}`),
        workspaceRoot: `/workspace/${index}`,
        workspaceExecutionTargetId: scope === "local" ? "local" : "ssh-target",
      },
    ],
  };
}

beforeEach(resetProjectGateStore);

it.each(["local", "remote"] as const)(
  "releases mounted %s lookups without another bootstrap or sidebar growth",
  (scope) => {
    useStore.getState().appendProjectCatalogPage("local", chatsPage);
    for (let index = 0; index < 30; index++) {
      const lookup = page(index, scope);
      const id = lookup.projects[0]!.id;
      const release = retainProjectDependency(id);
      useStore.getState().mergeProjectCatalogPage(lookup);
      expect(useStore.getState().projects).toHaveLength(2);
      expect(selectCatalogProjects(useStore.getState())).toHaveLength(1);
      release();
      release(); // Cleanup is idempotent, including StrictMode/unmount paths.
      expect(useStore.getState().projects).toHaveLength(1);
    }
    expect(useStore.getState().projectDependencyRefCounts).toEqual({});
    expect(useStore.getState().projectDependencyOnlyIds).toEqual({});
  },
);

it("keeps shared mounted dependencies until their final owner releases them", () => {
  const lookup = page(0);
  const id = lookup.projects[0]!.id;
  const first = retainProjectDependency(id);
  const second = retainProjectDependency(id);
  useStore.getState().mergeProjectCatalogPage(lookup);
  first();
  first();
  expect(useStore.getState().projectDependencyRefCounts?.[id]).toBe(1);
  expect(useStore.getState().projects).toHaveLength(1);
  second();
  expect(useStore.getState().projects).toEqual([]);
});

it("bounds unmounted/late lookup metadata without changing pagination or sidebar membership", () => {
  useStore.getState().appendProjectCatalogPage("local", { ...chatsPage, remainingCount: 50 });
  const before = useStore.getState();
  for (let index = 0; index < 30; index++) useStore.getState().mergeProjectCatalogPage(page(index));
  const state = useStore.getState();
  expect(state.projects).toHaveLength(PROJECT_DEPENDENCY_CACHE_LIMIT + 1);
  expect(Object.keys(state.projectCatalogSequenceById ?? {})).toHaveLength(
    PROJECT_DEPENDENCY_CACHE_LIMIT + 1,
  );
  expect(selectCatalogProjects(state).map((project) => project.id)).toEqual([
    chatsPage.projects[0]!.id,
  ]);
  expect(state.projectCatalogCursorByScope).toBe(before.projectCatalogCursorByScope);
  expect(state.projectCatalogRemainingCountByScope).toBe(
    before.projectCatalogRemainingCountByScope,
  );
  expect(state.projectCatalogGenerationByScope).toBe(before.projectCatalogGenerationByScope);
});

it("promotes a lookup to catalog membership when a normal page includes it", () => {
  const lookup = page(0);
  const release = retainProjectDependency(lookup.projects[0]!.id);
  useStore.getState().mergeProjectCatalogPage(lookup);
  expect(selectCatalogProjects(useStore.getState())).toEqual([]);
  useStore.getState().appendProjectCatalogPage("local", lookup);
  release();
  expect(selectCatalogProjects(useStore.getState())).toHaveLength(1);
});

it("does not demote existing catalog membership when a targeted lookup refreshes metadata", () => {
  const lookup = page(0);
  useStore.getState().appendProjectCatalogPage("local", lookup);
  useStore.getState().mergeProjectCatalogPage({ ...lookup, projectionSequence: 20 });
  expect(selectCatalogProjects(useStore.getState())).toHaveLength(1);
});

it("retains an omitted open catalog project as a dependency, not sidebar membership", () => {
  const lookup = page(0);
  const id = lookup.projects[0]!.id;
  useStore.getState().appendProjectCatalogPage("local", lookup);
  const release = retainProjectDependency(id);
  useStore.getState().syncBoundedCatalog(
    { local: emptyPage },
    {},
    {},
    {
      projectionSequence: 10,
      threads: [],
      recentThreadIds: [],
      pinnedThreadIds: [],
    },
    [],
  );
  expect(useStore.getState().projects).toHaveLength(1);
  expect(selectCatalogProjects(useStore.getState())).toEqual([]);
  release();
  expect(useStore.getState().projects).toEqual([]);
});

it("promotes live-created metadata even when a lookup resolved it first", () => {
  const readModel = makeReadModel(makeReadModelThread({}));
  const project = readModel.projects[0]!;
  const lookup = { ...page(0), projects: [{ ...page(0).projects[0]!, id: project.id }] };
  useStore.getState().mergeProjectCatalogPage(lookup);
  useStore.getState().applyOrchestrationEvent(
    makeEvent(
      "project.created",
      {
        ...project,
        projectId: project.id,
      },
      { sequence: 20 },
    ),
  );
  expect(selectCatalogProjects(useStore.getState()).map((entry) => entry.id)).toEqual([project.id]);
});
