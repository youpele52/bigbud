import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { describe, expect, it } from "vitest";

import { planSearchRoots, type SearchProjectRoot } from "./SystemSearch.roots.ts";

const REMOTE = "ssh:host=box&transport=agent";
const ALL_TIERS = ["currentProject", "otherProjectFiles", "remoteOutsideProjects"] as const;

function project(id: string, root: string, executionTargetId = "local"): SearchProjectRoot {
  return { projectId: ProjectId.makeUnsafe(id), title: `Project ${id}`, executionTargetId, root };
}

const projects = [
  project("remote-a", "/srv/app", REMOTE),
  project("current", "/work/current"),
  project("local-b", "/work/b"),
  project("dup", "/work/b"),
];

describe("planSearchRoots", () => {
  it("puts the current project in T2 and every other project in T4, local first", () => {
    const plan = planSearchRoots({
      tiers: ALL_TIERS,
      currentProjectId: ProjectId.makeUnsafe("current"),
      currentWorktree: null,
      projects,
      worktrees: [],
      includeRemote: true,
    });
    expect(plan.current).toMatchObject({ tier: "currentProject", root: "/work/current" });
    expect(plan.others.map((group) => group.executionTargetId)).toEqual(["local", REMOTE]);
    // The duplicate folder is searched once; the current project is never repeated in T4.
    expect(plan.others[0]!.roots.map((root) => root.root)).toEqual(["/work/b"]);
    expect(plan.others[1]!.roots).toMatchObject([{ tier: "otherProjectFiles", root: "/srv/app" }]);
    const ids = [plan.current!, ...plan.others.flatMap((group) => group.roots)].map(
      (r) => r.rootId,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses the current thread's worktree for T2 and keeps the project folder in neither tier", () => {
    const plan = planSearchRoots({
      tiers: ALL_TIERS,
      currentProjectId: ProjectId.makeUnsafe("current"),
      currentWorktree: {
        threadId: ThreadId.makeUnsafe("t1"),
        projectId: ProjectId.makeUnsafe("current"),
        executionTargetId: "local",
        root: "/worktrees/t1",
      },
      projects,
      worktrees: [],
      includeRemote: false,
    });
    expect(plan.current).toMatchObject({ root: "/worktrees/t1", label: "Project current" });
    expect(plan.others.flatMap((group) => group.roots).map((root) => root.root)).toEqual([
      "/work/b",
    ]);
  });

  it("skips remote folders when remote search is off", () => {
    const plan = planSearchRoots({
      tiers: ALL_TIERS,
      currentProjectId: null,
      currentWorktree: null,
      projects,
      worktrees: [
        {
          threadId: ThreadId.makeUnsafe("t2"),
          projectId: ProjectId.makeUnsafe("remote-a"),
          executionTargetId: REMOTE,
          root: "/home/me/.bigbud/worktrees/t2",
        },
      ],
      includeRemote: false,
    });
    expect(plan.current).toBeNull();
    expect(plan.others.map((group) => group.executionTargetId)).toEqual(["local"]);
  });

  it("puts only remote registered folders outside every project in T6", () => {
    const worktree = (id: string, root: string, target = REMOTE) => ({
      threadId: ThreadId.makeUnsafe(id),
      projectId: ProjectId.makeUnsafe("remote-a"),
      executionTargetId: target,
      root,
    });
    const plan = planSearchRoots({
      tiers: ALL_TIERS,
      currentProjectId: null,
      currentWorktree: null,
      projects,
      worktrees: [
        worktree("outside", "/home/me/.bigbud/worktrees/x"),
        worktree("inside", "/srv/app/.worktrees/y"),
        worktree("same", "/srv/app"),
        worktree("prefix", "/srv/application"),
        worktree("local", "/tmp/local-worktree", "local"),
      ],
      includeRemote: true,
    });
    const remote = plan.others.find((group) => group.executionTargetId === REMOTE)!;
    expect(
      remote.roots.filter((root) => root.tier === "remoteOutsideProjects").map((r) => r.root),
    ).toEqual(["/home/me/.bigbud/worktrees/x", "/srv/application"]);
    expect(plan.others.flatMap((group) => group.roots).map((r) => r.root)).not.toContain(
      "/tmp/local-worktree",
    );
  });

  it("excludes the built-in Chats project and honours the requested tiers", () => {
    const plan = planSearchRoots({
      tiers: ["otherProjectFiles"],
      currentProjectId: ProjectId.makeUnsafe("current"),
      currentWorktree: null,
      projects: [...projects, project("__chats__", "/home/me")],
      worktrees: [],
      includeRemote: true,
    });
    expect(plan.current).toBeNull();
    const roots = plan.others.flatMap((group) => group.roots).map((root) => root.root);
    expect(roots).not.toContain("/work/current");
    expect(roots).toEqual(["/work/b", "/srv/app"]);
  });
});
