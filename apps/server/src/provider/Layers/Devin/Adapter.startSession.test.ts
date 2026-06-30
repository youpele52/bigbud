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
  it.effect("registers bigbud_orchestration MCP with computer_use for ACP sessions", () =>
    Effect.gen(function* () {
      capturedAcpInputs.length = 0;
      const stateDir = yield* Effect.promise(() =>
        fs.mkdtemp(path.join(os.tmpdir(), "bigbud-devin-session-")),
      );
      const sessions = new Map<ThreadId, DevinSessionContext>();

      try {
        yield* makeStartSessionEffect(
          {
            ...makeAcpStartSessionTestDeps({ stateDir, sessions }),
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
