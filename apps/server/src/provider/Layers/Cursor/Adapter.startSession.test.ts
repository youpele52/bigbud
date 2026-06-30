import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ThreadId } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";

import { createFakeAcpSessionRuntime } from "../../acp/AcpSessionRuntime.test.helpers.ts";
import {
  makeAcpStartSessionTestDeps,
  readOrchestrationMcpServerSource,
} from "../AcpAdapter.startSession.test.helpers.ts";
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
  it.effect("registers bigbud_orchestration MCP with computer_use for ACP sessions", () =>
    Effect.gen(function* () {
      capturedAcpInputs.length = 0;
      const stateDir = yield* Effect.promise(() =>
        fs.mkdtemp(path.join(os.tmpdir(), "bigbud-cursor-session-")),
      );
      const sessions = new Map<ThreadId, CursorSessionContext>();

      try {
        yield* makeStartSessionEffect(
          {
            ...makeAcpStartSessionTestDeps({ stateDir, sessions }),
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
            Effect.gen(function* () {
              const acpInput = capturedAcpInputs.at(-1);
              assert.equal(!!acpInput?.mcpServers, true);
              assert.deepEqual(
                acpInput?.mcpServers?.map((server) => server.name),
                ["bigbud_orchestration"],
              );

              const source = yield* Effect.promise(() =>
                readOrchestrationMcpServerSource(acpInput?.mcpServers),
              );
              assert.equal(typeof source, "string");
              assert.include(source, "computer_use");
            }),
          ),
          Effect.scoped,
        );
      } finally {
        yield* Effect.promise(() => fs.rm(stateDir, { recursive: true, force: true }));
      }
    }),
  );
});
