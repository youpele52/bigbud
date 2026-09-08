import { ProjectId, ThreadId } from "@bigbud/contracts";
import { Effect, Option, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import { sendThreadMessageViaOrchestration } from "./ThreadOrchestrationTools.sendMessage.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ThreadDelegationRepositoryShape } from "../persistence/Services/ThreadDelegations.ts";

const callerId = ThreadId.makeUnsafe("caller");
const targetId = ThreadId.makeUnsafe("target");
const projectId = ProjectId.makeUnsafe("project");

const thread = (id: ThreadId, overrides = {}) => ({
  id,
  projectId,
  archivedAt: null,
  deletingAt: null,
  deletedAt: null,
  queuedPrompts: [],
  ...overrides,
});

function system(input?: {
  callerOverrides?: object;
  targetOverrides?: object;
  outcome?: "queued" | "started" | "missing";
  delegatedChild?: boolean;
}) {
  const threads = [
    thread(callerId, input?.callerOverrides),
    thread(targetId, input?.targetOverrides),
  ];
  const eventsByCommand = new Map<string, Array<any>>();
  const dispatch = vi.fn((command: any) => {
    if (eventsByCommand.has(command.commandId)) return Effect.succeed({ sequence: 1 });
    const events =
      input?.outcome === "started"
        ? [{ ...command, type: "thread.message-sent", payload: {} }]
        : input?.outcome === "missing"
          ? [{ ...command, type: "thread.session-set", payload: {} }]
          : [
              {
                ...command,
                type: "thread.prompt-queued",
                payload: { queuePosition: 3 },
              },
            ];
    eventsByCommand.set(command.commandId, events);
    return Effect.succeed({ sequence: 1 });
  });
  const readEventsByCommandId = vi.fn((commandId: string) =>
    Effect.succeed(eventsByCommand.get(commandId) ?? []),
  );
  const readEvents = vi.fn(() => Stream.fromIterable(Array.from({ length: 10_000 })));
  const repository = {
    findDirectByChild: vi.fn(() =>
      Effect.succeed(
        input?.delegatedChild
          ? Option.some({ callerThreadId: callerId, childThreadId: targetId } as never)
          : Option.none(),
      ),
    ),
  } as unknown as ThreadDelegationRepositoryShape;
  return {
    dispatch,
    readEvents,
    readEventsByCommandId,
    repository,
    engine: {
      getReadModel: () => Effect.succeed({ threads, projects: [] }),
      readEvents,
      readEventsByCommandId,
      dispatch,
    } as unknown as OrchestrationEngineShape,
  };
}

const send = (value: ReturnType<typeof system>, overrides = {}) =>
  Effect.runPromise(
    sendThreadMessageViaOrchestration({
      orchestrationEngine: value.engine,
      threadDelegationRepository: value.repository,
      callerThreadId: callerId,
      threadId: targetId,
      message: " Follow up ",
      delivery: "queue",
      invocationId: "call-1",
      ...overrides,
    }),
  );

describe("sendThreadMessageViaOrchestration", () => {
  it("uses stable retry identities and returns the original queued position", async () => {
    const value = system();
    await expect(send(value)).resolves.toEqual({ delivery: "queued", queuePosition: 3 });
    await expect(send(value)).resolves.toEqual({ delivery: "queued", queuePosition: 3 });
    const commands = value.dispatch.mock.calls.map(([command]) => command);
    expect(commands).toHaveLength(1);
    expect(value.readEventsByCommandId).toHaveBeenCalledTimes(3);
    expect(value.readEvents).not.toHaveBeenCalled();
  });

  it("reports immediate atomic sends as started", async () => {
    await expect(send(system({ outcome: "started" }))).resolves.toEqual({
      delivery: "started",
    });
  });

  it("fails clearly when the committed event set has no send outcome", async () => {
    await expect(send(system({ outcome: "missing" }))).rejects.toThrow(
      "did not produce a delivery outcome",
    );
  });

  it("enforces caller and target project, archive, delete, and existence checks", async () => {
    await expect(send(system({ callerOverrides: { deletedAt: "now" } }))).rejects.toThrow(
      "Caller thread",
    );
    await expect(
      send(system({ targetOverrides: { projectId: ProjectId.makeUnsafe("other") } })),
    ).rejects.toThrow("not accessible");
    await expect(send(system({ targetOverrides: { archivedAt: "now" } }))).rejects.toThrow(
      "not available",
    );
    await expect(send(system({ targetOverrides: { deletingAt: "now" } }))).rejects.toThrow(
      "not available",
    );
    await expect(send(system({ targetOverrides: { deletedAt: "now" } }))).rejects.toThrow(
      "was not found",
    );
    await expect(send(system(), { threadId: ThreadId.makeUnsafe("missing") })).rejects.toThrow(
      "was not found",
    );
  });

  it("allows a direct delegated child in another project", async () => {
    const value = system({
      targetOverrides: { projectId: ProjectId.makeUnsafe("other") },
      delegatedChild: true,
    });

    await expect(send(value)).resolves.toEqual({ delivery: "queued", queuePosition: 3 });
    expect(value.repository.findDirectByChild).toHaveBeenCalledWith({ childThreadId: targetId });
  });
});
