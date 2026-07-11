import { ThreadId } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";
import { vi } from "vitest";

import { createFakeAcpSessionRuntime } from "../../acp/AcpSessionRuntime.test.helpers.ts";
import { makeAcpStartSessionTestDeps } from "../AcpAdapter.startSession.test.helpers.ts";
import type { CursorSessionContext } from "./Adapter.helpers.ts";
import { makeStartSessionEffect } from "./Adapter.startSession.ts";

const capturedAcpInputs: Array<{
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
        },
      ).pipe(
        Effect.flatMap(() =>
          Effect.sync(() => {
            const acpInput = capturedAcpInputs.at(-1);
            assert.deepStrictEqual(
              acpInput?.mcpServers?.map((server) => server.name),
              ["bigbud_orchestration"],
            );
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
});
