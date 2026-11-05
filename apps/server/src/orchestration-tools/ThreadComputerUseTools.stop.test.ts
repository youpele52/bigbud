import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, FileSystem, Path } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  makeFakeEngine,
  makeThread,
  threadId,
  turnId,
} from "../computer-use/computerUseStop.testSupport.ts";
import { makeComputerUseActivity } from "../computer-use/Layers/ComputerUseActivity.ts";
import type { ComputerUseShape } from "../computer-use/Services/ComputerUse.ts";
import { computerUseViaOrchestration } from "./ThreadComputerUseTools.ts";

const THREAD = threadId("tools-stop");
const TURN = turnId("tools-stop-1");

const run = (stopFirst: boolean) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const activity = yield* makeComputerUseActivity;
    const { engine, dispatched } = makeFakeEngine([makeThread(THREAD, TURN)]);
    const execute = vi.fn<ComputerUseShape["execute"]>(() =>
      activity.entries.pipe(
        Effect.map((entries) => ({
          action: "capture" as const,
          surface: "browser" as const,
          summary: `entries=${JSON.stringify(entries.map((entry) => [entry.turnId, entry.actionsInFlight]))}`,
        })),
      ),
    );
    if (stopFirst) yield* activity.markStopped([{ threadId: THREAD, turnId: TURN }]);
    const exit = yield* Effect.exit(
      computerUseViaOrchestration({
        attachmentsDir: yield* fileSystem.makeTempDirectory({ prefix: "computer-use-stop-" }),
        computerUse: { execute, dispose: Effect.void },
        computerUseEnabled: true,
        fileSystem,
        orchestrationEngine: engine,
        path,
        serverMode: "desktop",
        threadId: THREAD,
        action: { action: "capture", surface: "browser" },
        activity,
      }),
    );
    return { exit, execute, dispatched, entries: yield* activity.entries };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("computerUseViaOrchestration with the activity registry", () => {
  it("registers the action under the session's running turn while it runs", async () => {
    const result = await Effect.runPromise(run(false));
    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(Exit.isSuccess(result.exit) && result.exit.value.summary).toBe(
      `entries=${JSON.stringify([[TURN, 1]])}`,
    );
    expect(result.entries).toMatchObject([{ turnId: TURN, actionsInFlight: 0 }]);
  });

  it("refuses a stopped turn before anything is recorded or executed", async () => {
    const result = await Effect.runPromise(run(true));
    expect(Exit.isFailure(result.exit) && String(result.exit.cause)).toContain(
      "stopped by the user",
    );
    expect(result.execute).not.toHaveBeenCalled();
    expect(result.dispatched).toEqual([]);
  });
});
