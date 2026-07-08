import { ThreadId } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";
import { vi } from "vitest";

import { createFakeAcpSessionRuntime } from "../../acp/AcpSessionRuntime.test.helpers.ts";
import { makeAcpStartSessionTestDeps } from "../AcpAdapter.startSession.test.helpers.ts";
import type { DevinSessionContext } from "./Adapter.helpers.ts";
import { makeStartSessionEffect } from "./Adapter.startSession.ts";

const capturedAcpInputs: Array<{
  readonly mcpServers?: ReadonlyArray<{
    readonly name: string;
    readonly args?: ReadonlyArray<string>;
  }>;
}> = [];

vi.mock("../../acp/DevinAcpSupport.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../acp/DevinAcpSupport.ts")>();
  return {
    ...original,
    makeDevinAcpRuntime: (input: Parameters<typeof original.makeDevinAcpRuntime>[0]) => {
      capturedAcpInputs.push(input);
      return Effect.succeed(createFakeAcpSessionRuntime());
    },
  };
});

const THREAD_ID = ThreadId.makeUnsafe("thread-devin-orchestration");

describe("DevinAdapter startSession orchestration wiring", () => {
  it.effect("starts ACP sessions without injecting thread orchestration MCP", () =>
    Effect.gen(function* () {
      capturedAcpInputs.length = 0;
      const sessions = new Map<ThreadId, DevinSessionContext>();
      const notificationScope = yield* Scope.make();
      yield* makeStartSessionEffect(
        {
          ...makeAcpStartSessionTestDeps({
            stateDir: "/tmp/bigbud-devin-session",
            sessions,
          }),
          notificationScope,
          getDevinSettings: () => Effect.succeed({ binaryPath: "devin" }),
        },
        {
          threadId: THREAD_ID,
          provider: "devin",
          cwd: "/tmp/devin-project",
          runtimeMode: "approval-required",
        },
      ).pipe(
        Effect.flatMap(() =>
          Effect.sync(() => {
            const acpInput = capturedAcpInputs.at(-1);
            assert.equal(acpInput?.mcpServers, undefined);
          }),
        ),
        Effect.scoped,
      );
      yield* Effect.ignore(Scope.close(notificationScope, Exit.void));
    }),
  );
});
