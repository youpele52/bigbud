import { ThreadId } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";
import { vi } from "vitest";

import { createFakeAcpSessionRuntime } from "../../acp/AcpSessionRuntime.test.helpers.ts";
import { makeAcpStartSessionTestDeps } from "../AcpAdapter.startSession.test.helpers.ts";
import type { CursorSessionContext } from "./Adapter.helpers.ts";
import { makeStartSessionEffect } from "./Adapter.startSession.ts";

const capturedAcpInputs: Array<{
  readonly cwd?: string;
  readonly spawnCwd?: string;
  readonly clientCapabilities?: unknown;
  readonly mcpServers?: ReadonlyArray<{
    readonly name: string;
    readonly args?: ReadonlyArray<string>;
  }>;
}> = [];

vi.mock("../../acp/CursorAcpSupport.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../acp/CursorAcpSupport.ts")>();
  return {
    ...original,
    makeCursorAcpRuntime: (input: Parameters<typeof original.makeCursorAcpRuntime>[0]) => {
      capturedAcpInputs.push(input);
      return Effect.succeed(createFakeAcpSessionRuntime());
    },
  };
});

const THREAD_ID = ThreadId.makeUnsafe("thread-cursor-orchestration");

describe("CursorAdapter startSession orchestration wiring", () => {
  it.effect("starts ACP sessions with the thread orchestration MCP", () =>
    Effect.gen(function* () {
      capturedAcpInputs.length = 0;
      const sessions = new Map<ThreadId, CursorSessionContext>();
      const notificationScope = yield* Scope.make();
      yield* makeStartSessionEffect(
        {
          ...makeAcpStartSessionTestDeps({
            stateDir: "/tmp/bigbud-cursor-session",
            sessions,
          }),
          notificationScope,
          getCursorSettings: () => Effect.succeed({ binaryPath: "agent", apiEndpoint: "" }),
        },
        {
          threadId: THREAD_ID,
          provider: "cursor",
          cwd: "/tmp/cursor-project",
          runtimeMode: "approval-required",
          sessionEpoch: 42,
        },
      ).pipe(
        Effect.flatMap(() =>
          Effect.sync(() => {
            const acpInput = capturedAcpInputs.at(-1);
            assert.deepStrictEqual(
              acpInput?.mcpServers?.map((server) => server.name),
              ["bigbud_orchestration"],
            );
            assert.strictEqual(sessions.get(THREAD_ID)?.sessionEpoch, 42);
          }),
        ),
        Effect.scoped,
      );
      yield* Effect.promise(
        () => sessions.get(THREAD_ID)?.orchestrationBridgeCleanup?.() ?? Promise.resolve(),
      );
      yield* Effect.ignore(Scope.close(notificationScope, Exit.void));
    }),
  );

  it.effect("preflights remote workspace capabilities before starting ACP", () =>
    Effect.gen(function* () {
      capturedAcpInputs.length = 0;
      const opened: string[] = [];
      const sessions = new Map<ThreadId, CursorSessionContext>();
      const notificationScope = yield* Scope.make();
      const deps = makeAcpStartSessionTestDeps({
        stateDir: "/tmp/bigbud-cursor-remote-session",
        sessions,
      });
      yield* makeStartSessionEffect(
        {
          ...deps,
          notificationScope,
          remoteAgentPtyResolver: {
            resolveWorkspace: async () =>
              ({
                openWorkspace: async (_handle: string, root: string) => {
                  opened.push(root);
                  return {};
                },
              }) as never,
            resolvePty: async () => ({}) as never,
          },
          getCursorSettings: () => Effect.succeed({ binaryPath: "agent", apiEndpoint: "" }),
        },
        {
          threadId: THREAD_ID,
          provider: "cursor",
          cwd: "/srv/cursor-project",
          runtimeMode: "approval-required",
          providerRuntimeExecutionTargetId: "local",
          workspaceExecutionTargetId: "ssh:devbox",
        },
      ).pipe(Effect.scoped);

      const acpInput = capturedAcpInputs.at(-1);
      assert.deepStrictEqual(opened, ["/srv/cursor-project"]);
      assert.notStrictEqual(acpInput?.cwd, "/srv/cursor-project");
      assert.strictEqual(acpInput?.cwd, acpInput?.spawnCwd);
      assert.deepStrictEqual(acpInput?.clientCapabilities, {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      });
      yield* Effect.promise(
        () => sessions.get(THREAD_ID)?.orchestrationBridgeCleanup?.() ?? Promise.resolve(),
      );
      yield* Effect.ignore(Scope.close(notificationScope, Exit.void));
    }),
  );

  it.effect("starts a remote workspace session when direct SSH has no PTY resolver", () =>
    Effect.gen(function* () {
      capturedAcpInputs.length = 0;
      const threadId = ThreadId.makeUnsafe("thread-cursor-direct-ssh");
      const sessions = new Map<ThreadId, CursorSessionContext>();
      const notificationScope = yield* Scope.make();
      const deps = makeAcpStartSessionTestDeps({
        stateDir: "/tmp/bigbud-cursor-direct-ssh-session",
        sessions,
      });

      yield* makeStartSessionEffect(
        {
          ...deps,
          notificationScope,
          remoteAgentPtyResolver: undefined,
          getCursorSettings: () => Effect.succeed({ binaryPath: "agent", apiEndpoint: "" }),
        },
        {
          threadId,
          provider: "cursor",
          cwd: "/srv/cursor-project",
          runtimeMode: "approval-required",
          providerRuntimeExecutionTargetId: "local",
          workspaceExecutionTargetId: "ssh:devbox",
        },
      ).pipe(Effect.scoped);

      const acpInput = capturedAcpInputs.at(-1);
      assert.notStrictEqual(acpInput?.cwd, "/srv/cursor-project");
      assert.strictEqual(acpInput?.cwd, acpInput?.spawnCwd);
      yield* Effect.promise(
        () => sessions.get(threadId)?.orchestrationBridgeCleanup?.() ?? Promise.resolve(),
      );
      yield* Effect.ignore(Scope.close(notificationScope, Exit.void));
    }),
  );
});
