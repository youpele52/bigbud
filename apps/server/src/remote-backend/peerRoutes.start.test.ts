import { CommandId, EventId, MessageId, ThreadId } from "@bigbud/contracts";
import { PEER_ROUTE_PATHS } from "@bigbud/contracts/constants/remotePeer.constant.ts";
import { Effect, Fiber } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { peerDelegateDigest } from "../peer-orchestration/peerWorker.delegate.ts";
import { peerUuid } from "../peer-orchestration/peerFixtures.test.helpers.ts";
import {
  delegateBody,
  makePeerRouteFixture,
  peerHeaders,
  WORKSPACE,
} from "./peerRoutes.test.helpers.ts";

let fixture: Awaited<ReturnType<typeof makePeerRouteFixture>> | undefined;
afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
});

const thread = async (id: string) =>
  (await fixture!.system.run(fixture!.system.engine.getReadModel())).threads.find(
    (entry) => entry.id === id,
  );

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not reached");
}

describe("worker peer child start", () => {
  it("uses the worker project's default model when the request names none (O-1)", async () => {
    fixture = await makePeerRouteFixture();
    const grant = await fixture.issue(1);
    const created = await fixture.post(
      PEER_ROUTE_PATHS.delegate,
      delegateBody(1),
      peerHeaders(grant),
    );
    expect(created.status).toBe(200);
    expect((await thread(created.json.childThreadId))?.modelSelection.model).toBe("gpt-5-codex");
  });

  it("completes a recorded start that no request finished (F-P8-3)", async () => {
    fixture = await makePeerRouteFixture();
    const grant = await fixture.issue(1);
    const body = delegateBody(2);
    const commandId = `peer:${grant.coordinatorAuthorityId}:${body.dispatchId}`;
    // The channel died right after the claim: the record exists, nothing was dispatched.
    await fixture.system.run(
      fixture.repositories.children.claim({
        commandId,
        dispatchId: body.dispatchId,
        coordinatorAuthorityId: grant.coordinatorAuthorityId,
        grantId: grant.grantId,
        childThreadId: "peer-thread-cut",
        requestDigest: peerDelegateDigest(body as never),
        workspaceRoot: WORKSPACE,
        provider: "codex",
        createdAt: new Date().toISOString(),
        start: {
          projectId: "peer-project",
          title: body.title,
          task: body.task,
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "approval-required",
        },
      }),
    );
    expect(await thread("peer-thread-cut")).toBeUndefined();
    // A status probe names the child (no re-send) and drives the start to completion.
    const status = await fixture.post(
      PEER_ROUTE_PATHS.status,
      { dispatchId: body.dispatchId },
      peerHeaders(grant),
    );
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({ childThreadId: "peer-thread-cut", state: "running" });
    const started = await until(
      () => thread("peer-thread-cut"),
      (child) => child?.messages.some((message) => message.role === "user") === true,
    );
    expect(started?.pendingTurnStart).not.toBeNull();
    const record = await fixture.system.run(fixture.repositories.children.findByCommand(commandId));
    expect(record?.startCompletedAt).not.toBeNull();
    // A repeat of the original delegate joins the same child without a second turn start.
    const repeat = await fixture.post(PEER_ROUTE_PATHS.delegate, body, peerHeaders(grant));
    expect(repeat.json).toMatchObject({ childThreadId: "peer-thread-cut", replayed: true });
    const turnEvents = await fixture.system.run(
      fixture.system.engine.readEventsByCommandId!(CommandId.makeUnsafe(`${commandId}:turn`)),
    );
    expect(turnEvents.filter((event) => event.type === "thread.turn-start-requested")).toHaveLength(
      1,
    );
  });

  it("finishes the start in the starter scope when the waiting request is interrupted", async () => {
    fixture = await makePeerRouteFixture();
    const grant = await fixture.issue(1);
    const body = delegateBody(3);
    const commandId = `peer:${grant.coordinatorAuthorityId}:${body.dispatchId}`;
    await fixture.system.run(
      fixture.repositories.children.claim({
        commandId,
        dispatchId: body.dispatchId,
        coordinatorAuthorityId: grant.coordinatorAuthorityId,
        grantId: grant.grantId,
        childThreadId: "peer-thread-interrupted",
        requestDigest: peerDelegateDigest(body as never),
        workspaceRoot: WORKSPACE,
        provider: "codex",
        createdAt: new Date().toISOString(),
        start: {
          projectId: "peer-project",
          title: body.title,
          task: body.task,
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "approval-required",
        },
      }),
    );
    await fixture.system.run(
      Effect.gen(function* () {
        const waiting = yield* Effect.forkChild(fixture!.starter.ensureStarted(commandId));
        yield* Fiber.interrupt(waiting);
      }),
    );
    const record = await until(
      () => fixture!.system.run(fixture!.repositories.children.findByCommand(commandId)),
      (child) => child?.startCompletedAt != null,
    );
    expect(record?.startFailure).toBeNull();
  });

  it("reports a child whose first turn failed to start as failed, and cancel settles (F-P8-1)", async () => {
    fixture = await makePeerRouteFixture();
    const grant = await fixture.issue(1);
    const ref = { dispatchId: peerUuid(2, 4) };
    const created = await fixture.post(
      PEER_ROUTE_PATHS.delegate,
      delegateBody(4),
      peerHeaders(grant),
    );
    const threadId = ThreadId.makeUnsafe(created.json.childThreadId);
    const child = await thread(threadId);
    const messageId = child!.messages.find((message) => message.role === "user")!.id;
    const at = new Date().toISOString();
    const run = fixture.system.run;
    const dispatch = fixture.system.engine.dispatch;
    await run(
      dispatch({
        type: "thread.turn.start.failed",
        commandId: CommandId.makeUnsafe("test-start-failed"),
        threadId,
        context: "provider-turn-start",
        detail: "model gpt-5-codex is not available",
        messageId: MessageId.makeUnsafe(messageId),
        createdAt: at,
      }),
    );
    await run(
      dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("test-start-failed-activity"),
        threadId,
        activity: {
          id: EventId.makeUnsafe("test-start-failed-activity"),
          tone: "error",
          kind: "provider.turn.start.failed",
          summary: "Provider turn start failed",
          payload: { detail: "model gpt-5-codex is not available" },
          turnId: null,
          createdAt: at,
        },
        createdAt: at,
      }),
    );
    // The session then settles to stopped: workflow status alone reads `idle` here.
    await run(
      dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("test-session-stopped"),
        threadId,
        session: {
          threadId,
          status: "stopped",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: at,
        },
        createdAt: at,
      }),
    );
    const status = await fixture.post(PEER_ROUTE_PATHS.status, ref, peerHeaders(grant));
    expect(status.json.state).toBe("failed");
    expect(status.json.result.outcome).toBe("failed");
    expect(status.json.result.summary).toContain("model gpt-5-codex is not available");
    const cancelled = await fixture.post(PEER_ROUTE_PATHS.cancel, ref, peerHeaders(grant));
    expect(cancelled.json.state).toBe("failed");
  });
});
