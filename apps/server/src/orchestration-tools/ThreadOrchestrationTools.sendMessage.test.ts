import { ProjectId, ThreadId } from "@bigbud/contracts";
import { Effect, Option, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import { sendThreadMessageViaOrchestration } from "./ThreadOrchestrationTools.sendMessage.ts";
import {
  makeTestCoordination,
  pushClientAnswer,
  resolvedActivityEvent,
} from "./ThreadCoordinationConfirmation.test.helpers.ts";
import type { ThreadCoordinationDeps } from "./ThreadCoordinationConfirmation.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ThreadDelegationRepositoryShape } from "../persistence/Services/ThreadDelegations.ts";

const callerId = ThreadId.makeUnsafe("caller");
const targetId = ThreadId.makeUnsafe("target");
const projectId = ProjectId.makeUnsafe("project");
const otherProject = ProjectId.makeUnsafe("other");
const projects = [
  { id: projectId, title: "Project", deletedAt: null },
  { id: otherProject, title: "Other", workspaceExecutionTargetId: "ssh:box", deletedAt: null },
];

const thread = (id: ThreadId, overrides = {}) => ({
  id,
  title: id === callerId ? "Caller" : "Target",
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
      getReadModel: () => Effect.succeed({ threads, projects }),
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
    expect(commands[0]).toMatchObject({
      originSegments: [
        {
          kind: "crossThreadAgent",
          actor: "agent",
          text: "Follow up",
          sourceThreads: [{ threadId: callerId, title: "Caller" }],
          verified: true,
        },
      ],
    });
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
    const foreign = system({ targetOverrides: { projectId: otherProject } });
    await expect(send(foreign)).resolves.toMatchObject({ status: "confirmation_required" });
    expect(foreign.dispatch).not.toHaveBeenCalled();
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

  it("allows a direct delegated child in another project with no prompt", async () => {
    const value = system({ targetOverrides: { projectId: otherProject }, delegatedChild: true });
    const { coordination } = makeTestCoordination();

    await expect(send(value, { coordination })).resolves.toEqual({
      delivery: "queued",
      queuePosition: 3,
    });
    expect(value.repository.findDirectByChild).toHaveBeenCalledWith({ childThreadId: targetId });
  });
});

describe("cross-project sendThreadMessageViaOrchestration", () => {
  const foreignSystem = (callerOverrides = {}) =>
    system({ targetOverrides: { projectId: otherProject }, callerOverrides });
  const required = async (
    value: ReturnType<typeof system>,
    coordination: ThreadCoordinationDeps,
  ) => {
    const result = await send(value, { coordination });
    if (!("status" in result) || result.status !== "confirmation_required") {
      throw new Error(`expected confirmation_required, got ${JSON.stringify(result)}`);
    }
    return result;
  };

  it("asks first, then delivers after a recorded client Allow, even in full access", async () => {
    const value = foreignSystem({ runtimeMode: "full-access" });
    const { coordination, log } = makeTestCoordination();
    const challenge = await required(value, coordination);
    expect(challenge).toMatchObject({
      targetProjectId: otherProject,
      targetProjectTitle: "Other",
      targetIsRemote: true,
    });
    expect(value.dispatch).not.toHaveBeenCalled();

    pushClientAnswer(log, {
      callerThreadId: callerId,
      question: challenge.question,
      answer: "Allow",
    });
    await expect(send(value, { coordination })).resolves.toEqual({
      delivery: "queued",
      queuePosition: 3,
    });
    const [command] = value.dispatch.mock.calls.map(([entry]) => entry);
    // The target keeps its own runtime mode and approvals: the send carries neither.
    expect(command).not.toHaveProperty("runtimeMode");
    expect(command).not.toHaveProperty("interactionMode");
    await expect(send(value, { coordination, invocationId: "call-2" })).resolves.toMatchObject({
      delivery: "queued",
    });
  });

  it("returns confirmation_denied for Deny and never grants from a provider-reported answer", async () => {
    const denied = foreignSystem();
    const deny = makeTestCoordination();
    const challenge = await required(denied, deny.coordination);
    pushClientAnswer(deny.log, {
      callerThreadId: callerId,
      question: challenge.question,
      answer: "Deny",
    });
    await expect(send(denied, { coordination: deny.coordination })).resolves.toMatchObject({
      status: "confirmation_denied",
    });

    const pi = foreignSystem({ runtimeMode: "full-access" });
    const auto = makeTestCoordination();
    const piChallenge = await required(pi, auto.coordination);
    auto.log.push(
      resolvedActivityEvent({
        threadId: callerId,
        sequence: auto.log.nextSequence(),
        requestId: "pi-confirm",
        answers: { [piChallenge.question]: "Allow" },
      }),
    );
    await required(pi, auto.coordination);
    expect(pi.dispatch).not.toHaveBeenCalled();
  });

  it("refuses cross-project sends when the grants service is absent", async () => {
    const value = foreignSystem();
    await expect(send(value, { coordination: {} })).resolves.toMatchObject({
      status: "confirmation_required",
    });
    expect(value.dispatch).not.toHaveBeenCalled();
  });
});
