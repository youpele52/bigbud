import {
  AutomationId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ServerCreateAutomationInput,
  ThreadId,
  WS_METHODS,
} from "@bigbud/contracts";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { makeWsRpcOrchestrationServerHandlers } from "./wsRpcHandlers.orchestrationServer.ts";
import type { WsRpcContext } from "./wsRpcContext.ts";
import { makeWsRpcAutomationHandlers } from "./wsRpcHandlers.automation.ts";
import { AutomationScheduleNotFoundError } from "../persistence/Errors.ts";

const projectId = ProjectId.makeUnsafe("automation-lifecycle-project");
const targetThreadId = ThreadId.makeUnsafe("automation-lifecycle-thread");
const normalInput = {
  projectId,
  targetThreadId,
  title: "Lifecycle automation",
  prompt: "Run lifecycle test",
  scheduleKind: "custom" as const,
  scheduleLabel: "Hourly",
  cronExpression: "0 * * * *",
  timezone: "UTC",
};

function makeAutomationHandlers(input: {
  readonly create?: WsRpcContext["automationScheduleRepository"]["create"];
  readonly delete?: WsRpcContext["automationScheduleRepository"]["delete"];
  readonly getOwningAutomationId?: WsRpcContext["automationScheduleRepository"]["getOwningAutomationId"];
  readonly dispatch?: WsRpcContext["dispatchNormalizedCommand"];
}) {
  return makeWsRpcAutomationHandlers({
    automationScheduleRepository: {
      create: input.create ?? (() => Effect.die("not implemented")),
      getById: () => Effect.succeed(Option.some({ targetThreadId, deletedAt: null } as never)),
      delete: input.delete ?? (() => Effect.succeed(false)),
      getOwningAutomationId: input.getOwningAutomationId ?? (() => Effect.succeed(Option.none())),
    },
    projectionThreadRepository: {
      getById: () => Effect.succeed(Option.some({ projectId, deletedAt: null } as never)),
    },
    dispatchNormalizedCommand: input.dispatch ?? (() => Effect.succeed({ sequence: 1 })),
    schedulerReactor: { triggerNow: () => Effect.succeed({ status: "not_found" as const }) },
  } as unknown as WsRpcContext);
}

describe("automation-owned thread lifecycle", () => {
  it("creates an owned automation for a server-generated thread while normal creation is non-owning", async () => {
    const schedules: Array<Record<string, unknown>> = [];
    const commands: Array<{ readonly type: string; readonly threadId: ThreadId }> = [];
    const handlers = makeAutomationHandlers({
      create: (input) => {
        schedules.push(input as Record<string, unknown>);
        return Effect.succeed(input as never);
      },
      dispatch: (command) => {
        commands.push(command as { readonly type: string; readonly threadId: ThreadId });
        return Effect.succeed({ sequence: 1 });
      },
    });

    await Effect.runPromise(
      handlers[WS_METHODS.serverCreateAutomation]({
        ...normalInput,
        ownsTargetThread: true,
      } as never),
    );
    await Effect.runPromise(
      handlers[WS_METHODS.serverCreateOwnedAutomation]({
        ...normalInput,
        modelSelection: { provider: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      }),
    );

    expect(schedules[0]).toMatchObject({ targetThreadId, ownsTargetThread: false });
    expect(schedules[1]).toMatchObject({ ownsTargetThread: true });
    expect(schedules[1]?.targetThreadId).not.toBe(targetThreadId);
    expect(commands.map((command) => command.type)).toEqual([
      "thread.meta.update",
      "thread.create",
    ]);
    expect(commands[1]?.threadId).toBe(schedules[1]?.targetThreadId);
  });

  it("does not expose ownership in the public creation contract", () => {
    const decode = Schema.decodeUnknownSync(ServerCreateAutomationInput);

    expect(() =>
      decode({ ...normalInput, ownsTargetThread: true }, { onExcessProperty: "error" }),
    ).toThrow();
  });

  it("rejects ordinary deletion of an owned thread with its owner ID", async () => {
    const ownerId = AutomationId.makeUnsafe("automation-owner");
    let dispatchCount = 0;
    const dispatch = () => {
      dispatchCount += 1;
      return Effect.succeed({ sequence: 1 });
    };
    const handlers = makeWsRpcOrchestrationServerHandlers({
      normalizeDispatchCommand: (command: unknown) => Effect.succeed(command as never),
      automationScheduleRepository: {
        getOwningAutomationId: () => Effect.succeed(Option.some(ownerId)),
      },
      dispatchNormalizedCommand: dispatch,
    } as unknown as WsRpcContext);

    const dispatchCommand = handlers[ORCHESTRATION_WS_METHODS.dispatchCommand] as unknown as (
      input: unknown,
    ) => Effect.Effect<unknown>;
    const exit = await Effect.runPromise(
      Effect.exit(
        dispatchCommand({
          type: "thread.delete",
          commandId: "delete-owned-thread",
          threadId: targetThreadId,
        } as never),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
      expect(error).toMatchObject({
        _tag: "OrchestrationDispatchCommandError",
        code: "automation_owned_thread",
        automationId: ownerId,
      });
    }
    expect(dispatchCount).toBe(0);
  });

  it("deletes an owned target only after its final owner is removed", async () => {
    const commands: Array<{ readonly type: string; readonly threadId: ThreadId }> = [];
    let rechecked = false;
    const handlers = makeAutomationHandlers({
      delete: () => Effect.succeed(true),
      getOwningAutomationId: () => {
        rechecked = true;
        return Effect.succeed(Option.none());
      },
      dispatch: (command) => {
        commands.push(command as { readonly type: string; readonly threadId: ThreadId });
        return Effect.succeed({ sequence: 1 });
      },
    });

    await Effect.runPromise(
      handlers[WS_METHODS.serverDeleteAutomation]({
        automationId: AutomationId.makeUnsafe("final-owner"),
      }),
    );

    expect(rechecked).toBe(true);
    expect(commands).toMatchObject([{ type: "thread.delete", threadId: targetThreadId }]);
  });

  it("keeps the target when another owner remains after deletion", async () => {
    let dispatchCount = 0;
    const dispatch = () => {
      dispatchCount += 1;
      return Effect.succeed({ sequence: 1 });
    };
    const handlers = makeAutomationHandlers({
      delete: () => Effect.succeed(true),
      getOwningAutomationId: () =>
        Effect.succeed(Option.some(AutomationId.makeUnsafe("remaining-owner"))),
      dispatch,
    });

    await Effect.runPromise(
      handlers[WS_METHODS.serverDeleteAutomation]({
        automationId: AutomationId.makeUnsafe("removed-owner"),
      }),
    );

    expect(dispatchCount).toBe(0);
  });

  it("compensates an owned-thread creation failure before an owner is persisted", async () => {
    const commands: Array<{ readonly type: string }> = [];
    const handlers = makeAutomationHandlers({
      create: () =>
        Effect.fail(
          new AutomationScheduleNotFoundError({
            automationId: AutomationId.makeUnsafe("failed-owner"),
          }),
        ),
      dispatch: (command) => {
        commands.push(command as { readonly type: string });
        return Effect.succeed({ sequence: 1 });
      },
    });

    const exit = await Effect.runPromise(
      Effect.exit(
        handlers[WS_METHODS.serverCreateOwnedAutomation]({
          ...normalInput,
          modelSelection: { provider: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(commands.map((command) => command.type)).toEqual(["thread.create", "thread.delete"]);
  });
});
