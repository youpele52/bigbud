import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { TerminalIdleWork, TerminalManagerShape } from "../../terminal/Services/Manager.ts";

import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "./OrchestrationEngine.test.runtime.ts";

const projectId = ProjectId.makeUnsafe("inyosira-idle");
const quietThread = ThreadId.makeUnsafe("inyosira-idle-quiet");
const busyThread = ThreadId.makeUnsafe("inyosira-idle-busy");
const createdAt = "2026-10-30T00:00:00.000Z";

const idle = (id: string, threadId: ThreadId, expectedRevision: number) =>
  ({
    type: "thread.organization.idle",
    commandId: CommandId.makeUnsafe(id),
    threadId,
    expectedRevision,
    fromState: "present",
    destination: "done",
    createdAt,
  }) as const;

const terminalStub = (get: () => TerminalIdleWork): TerminalManagerShape => ({
  getThreadIdleWork: () => Effect.sync(get),
  open: () => Effect.die("unused"),
  snapshot: () => Effect.die("unused"),
  listShellProfiles: () => Effect.die("unused"),
  write: () => Effect.void,
  resize: () => Effect.void,
  clear: () => Effect.void,
  restart: () => Effect.die("unused"),
  close: () => Effect.void,
  subscribe: () => Effect.succeed(() => {}),
});

describe("Inyosira idle cleanup in the engine", () => {
  it("rechecks selected candidates, persists no-op receipts, preserves manual moves and full waits", () =>
    withDatabase("inyosira-terminal-idle-", async (dbPath) => {
      let work: TerminalIdleWork = { state: "idle", quietSince: null };
      const runtime = createRuntime(
        dbPath,
        terminalStub(() => work),
      );
      try {
        const engine = await engineFor(runtime);
        const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
        for (const command of createCommands(projectId, [quietThread]))
          await run(engine.dispatch(command));
        const before = (await run(engine.getReadModel())).snapshotSequence;
        // Candidate was selected while idle; work is observed before command processing.
        const selected = idle("terminal-started-after-selection", quietThread, 0);
        work = { state: "busy", quietSince: null };
        await run(engine.dispatch(selected));
        expect((await run(engine.getReadModel())).snapshotSequence).toBe(before);
        work = { state: "idle", quietSince: null };
        await run(engine.dispatch(selected)); // accepted no-op receipt is not replayed as a move
        expect((await run(engine.getReadModel())).snapshotSequence).toBe(before);
        work = { state: "unknown", quietSince: null };
        await run(engine.dispatch(idle("terminal-unknown", quietThread, 0)));
        expect((await run(engine.getReadModel())).snapshotSequence).toBe(before);
        work = { state: "busy", quietSince: null };
        await run(
          engine.dispatch({
            type: "thread.organization.move",
            commandId: CommandId.makeUnsafe("manual-later"),
            threadId: quietThread,
            state: "later",
            createdAt,
          }),
        );
        const later = (await run(engine.getReadModel())).threads.find(
          (thread) => thread.id === quietThread,
        )!;
        expect(later.organization?.state).toBe("later");
        await run(engine.dispatch({ ...idle("older-busy", quietThread, 1), fromState: "later" }));
        expect(
          (await run(engine.getReadModel())).threads.find((thread) => thread.id === quietThread)!
            .organization?.state,
        ).toBe("later");
        // The deliberate move is aged from server acceptance, not the caller's old createdAt.
        const finish = Date.parse(later.organization!.changedAt!);
        work = { state: "idle", quietSince: finish };
        await run(
          engine.dispatch({
            ...idle("older-quiet-too-soon", quietThread, 1),
            fromState: "later",
            terminalIdleCutoff: new Date(finish - 1).toISOString(),
          }),
        );
        expect(
          (await run(engine.getReadModel())).threads.find((thread) => thread.id === quietThread)!
            .organization?.state,
        ).toBe("later");
        await run(
          engine.dispatch({
            ...idle("older-quiet-complete", quietThread, 1),
            fromState: "later",
            terminalIdleCutoff: new Date(finish).toISOString(),
          }),
        );
        expect(
          (await run(engine.getReadModel())).threads.find((thread) => thread.id === quietThread)!
            .organization?.state,
        ).toBe("done");
      } finally {
        await runtime.dispose();
      }
    }));
  it("moves a quiet thread once and never a thread with admitted work", () =>
    withDatabase("inyosira-idle-", async (dbPath) => {
      const runtime = createRuntime(dbPath);
      try {
        const engine = await engineFor(runtime);
        const run = <A, E>(effect: import("effect").Effect.Effect<A, E>) =>
          runtime.runPromise(effect);
        for (const command of createCommands(projectId, [quietThread, busyThread])) {
          await run(engine.dispatch(command));
        }
        // Work admitted before the idle move: the turn start is pending, so idle declines.
        await run(
          engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("busy-turn"),
            threadId: busyThread,
            message: {
              messageId: MessageId.makeUnsafe("busy-message"),
              role: "user",
              text: "keep going",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt,
          }),
        );
        await run(engine.dispatch(idle("idle-busy", busyThread, 0)));
        await run(engine.dispatch(idle("idle-stale", quietThread, 7)));
        await run(engine.dispatch(idle("idle-quiet", quietThread, 0)));
        await run(engine.dispatch(idle("idle-quiet-again", quietThread, 0)));

        const threads = (await run(engine.getReadModel())).threads;
        const organization = (threadId: ThreadId) =>
          threads.find((thread) => thread.id === threadId)?.organization;
        expect(organization(quietThread)).toMatchObject({ state: "done", revision: 1 });
        expect(organization(busyThread)).toMatchObject({ state: "present", revision: 0 });
      } finally {
        await runtime.dispose();
      }
    }));
});
