import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@bigbud/contracts";
import { BUILT_IN_CHATS_PROJECT_ID } from "@bigbud/contracts/constants/project.constant.ts";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { ensureSessionForThread } from "./ProviderCommandReactorSessionOps.ts";
import { assertActiveV2SessionLocation } from "./ProviderCommandReactorSessionOps.activeLocation.ts";
import {
  makeSettingsHarness,
  createdAt,
  threadId,
} from "./ProviderCommandReactorSessionOps.settings.test.helpers.ts";
import type { SessionOpServices } from "./ProviderCommandReactorSessionOps.types.ts";

it("compares remote runtime Locations without resolving them on the local filesystem", async () => {
  const h = makeSettingsHarness("opencodeV2");
  await Effect.runPromise(ensureSessionForThread(h.services)(threadId, createdAt));
  const session = {
    ...h.activeSession!,
    providerRuntimeExecutionTargetId: "remote",
    cwd: "/synthetic-remote/workspace",
  };
  await expect(
    Effect.runPromise(assertActiveV2SessionLocation(session, "/synthetic-remote/./workspace")),
  ).resolves.toBeUndefined();
  await expect(
    Effect.runPromise(assertActiveV2SessionLocation(session, "/synthetic-remote/other")),
  ).rejects.toThrow("active session Location");
});

it.each([
  "changed-default",
  "equivalent-alias",
  "project",
  "worktree",
  "missing-active-path",
] as const)(
  "active V2 reuse validates the effective Location (%s) before any mutation",
  async (scenario) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "v2-active-location-")));
    try {
      const a = path.join(root, "a"),
        b = path.join(root, "b"),
        alias = path.join(root, "alias");
      await Promise.all([mkdir(a), mkdir(b)]);
      await symlink(a, alias, "junction");
      const h = makeSettingsHarness("opencodeV2");
      const projectId =
        scenario === "project" || scenario === "worktree"
          ? ProjectId.makeUnsafe("project")
          : BUILT_IN_CHATS_PROJECT_ID;
      h.updateThread({
        projectId,
        workspaceExecutionTargetId: "local",
        executionTargetId: "local",
        worktreePath: scenario === "worktree" ? a : null,
      });
      let defaultChatCwd = a;
      const services = {
        ...h.services,
        orchestrationEngine: {
          ...h.services.orchestrationEngine,
          getReadModel: () =>
            Effect.succeed({
              threads: [h.thread],
              projects: [
                {
                  id: projectId,
                  workspaceRoot: scenario === "project" ? a : scenario === "worktree" ? b : null,
                },
              ],
            }),
        },
        serverSettingsService: {
          getSettings: Effect.sync(() => ({ ...DEFAULT_SERVER_SETTINGS, defaultChatCwd })),
        },
      } as unknown as SessionOpServices;
      await Effect.runPromise(ensureSessionForThread(services)(threadId, createdAt));
      h.setActiveSession({ ...h.activeSession!, cwd: a });
      h.startSession.mockClear();
      h.setThreadSession.mockClear();
      h.assertRuntimeStartAllowed.mockClear();
      const before = h.activeSession;
      defaultChatCwd = scenario === "equivalent-alias" ? alias : b;
      if (scenario === "missing-active-path") await rm(a, { recursive: true });
      const result = await Effect.runPromise(
        Effect.result(ensureSessionForThread(services)(threadId, createdAt)),
      );
      if (scenario === "changed-default" || scenario === "missing-active-path")
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { issue: expect.stringContaining("active session Location") },
        });
      else expect(result).toMatchObject({ _tag: "Success", success: threadId });
      expect(h.activeSession).toBe(before);
      expect(h.startSession).not.toHaveBeenCalled();
      expect(h.startSessionFresh).not.toHaveBeenCalled();
      expect(h.stopSession).not.toHaveBeenCalled();
      expect(h.sendTurn).not.toHaveBeenCalled();
      expect(h.setThreadSession).not.toHaveBeenCalled();
      expect(h.assertRuntimeStartAllowed).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
