import { describe, expect, it } from "vitest";
import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas";

import type { Project, SidebarThreadSummary } from "../../models/types";
import {
  type ConnectionActivityThread,
  describeDisconnectConfirmation,
  shouldConfirmDisconnect,
  summarizeExecutionTargetActivity,
} from "./Sidebar.projectActions.connection.logic";

const TARGET = "ssh:host=devbox&user=root&port=22&auth=ssh-key&transport=agent";
const OTHER_TARGET = "ssh:host=build&user=ci&port=22&auth=ssh-key";

function project(id: string, name: string, target: string): Project {
  return {
    id: ProjectId.makeUnsafe(id),
    name,
    cwd: `/srv/${id}`,
    workspaceExecutionTargetId: target as NonNullable<Project["workspaceExecutionTargetId"]>,
    defaultModelSelection: null,
    scripts: [],
  };
}

type TargetId = NonNullable<SidebarThreadSummary["executionTargetId"]>;

function thread(
  id: string,
  projectId: string,
  options: { running?: boolean; target?: string; runtimeTarget?: string } = {},
): ConnectionActivityThread {
  return {
    id: ThreadId.makeUnsafe(id),
    projectId: ProjectId.makeUnsafe(projectId),
    ...(options.target ? { workspaceExecutionTargetId: options.target as TargetId } : {}),
    ...(options.runtimeTarget
      ? {
          providerRuntimeExecutionTargetId: options.runtimeTarget as TargetId,
        }
      : {}),
    session: options.running
      ? ({
          orchestrationStatus: "running",
          activeTurnId: "turn-1",
        } as unknown as SidebarThreadSummary["session"])
      : null,
    latestTurn: null,
  };
}

const projects = [
  project("app", "App", TARGET),
  project("docs", "Docs", TARGET),
  project("ci", "CI", OTHER_TARGET),
  project("local", "Local", "local"),
];

describe("summarizeExecutionTargetActivity", () => {
  it("counts running turns and terminals on every thread that uses the target", () => {
    const terminals: Record<string, readonly string[]> = {
      "app-idle": ["default", "term-2"],
      "ci-running": ["default"],
    };
    const activity = summarizeExecutionTargetActivity({
      executionTargetId: TARGET,
      projectId: ProjectId.makeUnsafe("app"),
      projects,
      threads: [
        thread("app-running", "app", { running: true }),
        thread("app-idle", "app"),
        thread("docs-running", "docs", { running: true }),
        thread("ci-running", "ci", { running: true }),
        thread("local-on-target", "local", { running: true, runtimeTarget: TARGET }),
        thread("local-explicit", "local", { running: true, target: TARGET }),
      ],
      runningTerminalIds: (threadId) => terminals[threadId] ?? [],
    });

    expect(activity).toEqual({
      activeTurnCount: 4,
      runningTerminalCount: 2,
      sharedWorkspaceNames: ["Docs"],
    });
    expect(shouldConfirmDisconnect(activity)).toBe(true);
  });

  it("disconnects immediately when nothing is running on the target", () => {
    const activity = summarizeExecutionTargetActivity({
      executionTargetId: OTHER_TARGET,
      projectId: ProjectId.makeUnsafe("ci"),
      projects,
      threads: [thread("ci-idle", "ci"), thread("app-running", "app", { running: true })],
      runningTerminalIds: () => [],
    });

    expect(activity).toEqual({
      activeTurnCount: 0,
      runningTerminalCount: 0,
      sharedWorkspaceNames: [],
    });
    expect(shouldConfirmDisconnect(activity)).toBe(false);
  });

  it("asks for confirmation for running terminals alone", () => {
    expect(
      shouldConfirmDisconnect({
        activeTurnCount: 0,
        runningTerminalCount: 1,
        sharedWorkspaceNames: [],
      }),
    ).toBe(true);
  });
});

describe("describeDisconnectConfirmation", () => {
  it("names the running work and how many other workspaces share the connection", () => {
    const copy = describeDisconnectConfirmation({
      projectId: ProjectId.makeUnsafe("app"),
      projectName: "App",
      executionTargetId: TARGET,
      activeTurnCount: 1,
      runningTerminalCount: 2,
      sharedWorkspaceNames: ["Docs", "Infra"],
    });

    expect(copy.title).toBe('Disconnect "App"?');
    expect(copy.description).toContain("1 running turn and 2 running terminals");
    expect(copy.description).toContain("2 other workspaces share this connection");
    expect(copy.description).toContain("bigbud remote agent keeps running on the host");
    expect(copy.description).not.toContain("Terminals will close");
  });

  it("warns that direct SSH terminals close and their remote commands end", () => {
    const copy = describeDisconnectConfirmation({
      projectId: ProjectId.makeUnsafe("ci"),
      projectName: "CI",
      executionTargetId: `${OTHER_TARGET}&transport=direct-ssh`,
      activeTurnCount: 0,
      runningTerminalCount: 1,
      sharedWorkspaceNames: [],
    });

    expect(copy.description).toContain(
      "Terminals will close, and commands running in them on the host will end.",
    );
    expect(copy.description).not.toContain("keeps running on the host");
  });

  it("omits the shared-connection note for a single workspace", () => {
    const copy = describeDisconnectConfirmation({
      projectId: ProjectId.makeUnsafe("app"),
      projectName: "App",
      executionTargetId: TARGET,
      activeTurnCount: 0,
      runningTerminalCount: 1,
      sharedWorkspaceNames: [],
    });

    expect(copy.description.startsWith("1 running terminal will lose the connection")).toBe(true);
    expect(copy.description).not.toContain("other workspace");
  });
});
