import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@bigbud/contracts";
import { BUILT_IN_CHATS_PROJECT_ID } from "@bigbud/contracts/constants/project.constant.ts";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { ensureSessionForThread } from "./ProviderCommandReactorSessionOps.ts";
import {
  makeSettingsHarness,
  createdAt,
  threadId,
} from "./ProviderCommandReactorSessionOps.settings.test.helpers.ts";
import type { SessionOpServices } from "./ProviderCommandReactorSessionOps.types.ts";

function locationHarness(projectId: ProjectId, workspaceRoot: string | null) {
  const harness = makeSettingsHarness("opencodeV2");
  harness.updateThread({
    projectId,
    workspaceExecutionTargetId: "local",
    executionTargetId: "local",
  });
  const projects = [{ id: projectId, workspaceRoot }];
  const services = {
    ...harness.services,
    orchestrationEngine: {
      ...harness.services.orchestrationEngine,
      getReadModel: () => Effect.succeed({ threads: [harness.thread], projects }),
    },
    serverSettingsService: {
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        defaultChatCwd: "/configured-chats",
      }),
    },
  } as unknown as SessionOpServices;
  return { ...harness, services, projects };
}

it.each(["chats", "project", "worktree"])(
  "starts V2 %s in the same canonical directory used by setup",
  async (kind) => {
    const h = locationHarness(
      kind === "chats" ? BUILT_IN_CHATS_PROJECT_ID : ProjectId.makeUnsafe("project"),
      kind === "chats" ? null : "/actual-project",
    );
    if (kind === "worktree") h.updateThread({ worktreePath: "/actual-worktree" });
    await Effect.runPromise(ensureSessionForThread(h.services)(threadId, createdAt));
    expect(h.startSession).toHaveBeenCalledOnce();
    expect(h.startSession.mock.calls[0]?.[1].cwd).toBe(
      kind === "chats"
        ? "/configured-chats"
        : kind === "worktree"
          ? "/actual-worktree"
          : "/actual-project",
    );
  },
);

it.each(["missing-project", "missing-project-with-worktree", "missing-path"])(
  "rejects %s before discovering or starting a V2 session",
  async (kind) => {
    const h = locationHarness(ProjectId.makeUnsafe("project"), null);
    if (kind.startsWith("missing-project")) h.projects.splice(0);
    if (kind === "missing-project-with-worktree") h.updateThread({ worktreePath: "/worktree" });
    const listSessions = vi.spyOn(h.services.providerService, "listSessions");
    const result = await Effect.runPromise(
      Effect.result(ensureSessionForThread(h.services)(threadId, createdAt)),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { issue: expect.stringContaining("no canonical native Location") },
    });
    expect(h.startSession).not.toHaveBeenCalled();
    expect(listSessions).not.toHaveBeenCalled();
    expect(h.setThreadSession).not.toHaveBeenCalled();
  },
);
