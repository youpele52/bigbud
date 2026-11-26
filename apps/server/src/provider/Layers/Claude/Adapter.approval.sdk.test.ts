import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { ApprovalRequestId, ProviderItemId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Random, Stream } from "effect";

import { ClaudeAdapter } from "../../Services/Claude/Adapter.ts";
import { THREAD_ID, makeDeterministicRandomService, makeHarness } from "./Adapter.test.helpers.ts";

type ClaudeCanUseTool = NonNullable<
  NonNullable<
    ReturnType<ReturnType<typeof makeHarness>["getLastCreateQueryInput"]>
  >["options"]["canUseTool"]
>;

function approvalCallback(harness: ReturnType<typeof makeHarness>): ClaudeCanUseTool {
  const callback = harness.getLastCreateQueryInput()?.options.canUseTool;
  if (!callback) throw new Error("Expected a Claude canUseTool callback.");
  return callback;
}

function requireRequest(
  event: ProviderRuntimeEvent,
): Extract<ProviderRuntimeEvent, { type: "request.opened" }> {
  if (event.type !== "request.opened") throw new Error("Expected request.opened event.");
  return event;
}

describe("Claude SDK approval callbacks", () => {
  it.effect.each([true, false])(
    "refuses a pending request before dispatch (live turn: %s)",
    (live) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "approval-required",
        });
        yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);
        if (live) {
          yield* adapter.sendTurn({ threadId: session.threadId, input: "first", attachments: [] });
          yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);
        }
        const permission = approvalCallback(harness)(
          "Bash",
          { command: "pwd" },
          {
            signal: new AbortController().signal,
            toolUseID: "tool-pending",
            requestId: "pending-before-projection",
          },
        );
        const opened = yield* Stream.runHead(adapter.streamEvents);
        if (opened._tag !== "Some") throw new Error("Expected request.opened");
        const request = requireRequest(opened.value);
        assert.isDefined(request.requestId);
        const requestId = ApprovalRequestId.makeUnsafe(String(request.requestId));
        const failure = yield* Effect.flip(
          adapter.sendTurn({
            threadId: session.threadId,
            input: "follow up",
            attachments: [],
          }),
        );
        assert.equal(failure._tag, "ProviderAdapterValidationError");
        assert.equal(
          "failureClass" in failure ? failure.failureClass : undefined,
          live ? "busy" : "invalid-request",
        );
        const refusal = "turnStartRefusal" in failure ? failure.turnStartRefusal : undefined;
        const generation = refusal?.gate.approvalRequests[0]?.generation;
        if (typeof generation !== "string") throw new Error("Expected a request generation");
        assert.deepEqual(refusal, {
          kind: "pending-interaction",
          gate: {
            provider: "claudeAgent",
            sessionEpoch: 0,
            approvalRequests: [{ requestId, generation }],
            userInputRequests: [],
          },
        });
        yield* adapter.respondToRequest(session.threadId, requestId, "decline");
        assert.equal((yield* Effect.promise(() => permission))?.behavior, "deny");
        const closed = yield* Stream.runHead(adapter.streamEvents);
        assert.equal(
          closed._tag === "Some" ? closed.value.requestGeneration : undefined,
          generation,
        );
        yield* adapter.stopSession(session.threadId);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect.each([
    { label: "local", toolName: "mcp__bigbud_orchestration__browser", remote: false },
    { label: "remote", toolName: "mcp__bigbud_remote_workspace__read", remote: true },
  ])("preserves $label MCP callback correlation and approval", ({ toolName, remote }) => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
        ...(remote
          ? {
              executionTargetId: "ssh:host=devbox&user=root&port=22",
              cwd: "/srv/project",
            }
          : {}),
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const permission = approvalCallback(harness)(
        toolName,
        {},
        {
          signal: new AbortController().signal,
          suggestions: [
            {
              type: "addRules",
              rules: [{ toolName }],
              behavior: "allow",
              destination: "localSettings",
            },
          ],
          toolUseID: `tool-${toolName}`,
          requestId: `request-${toolName}`,
          agentID: "agent-mcp",
        },
      );
      const opened = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(opened._tag, "Some");
      if (opened._tag !== "Some") return;
      const request = requireRequest(opened.value);
      assert.deepEqual(request.providerRefs, {
        providerItemId: ProviderItemId.makeUnsafe(`tool-${toolName}`),
        providerRequestId: `request-${toolName}`,
        providerAgentId: "agent-mcp",
      });
      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.makeUnsafe(String(request.requestId)),
        "acceptForSession",
      );
      const resolved = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolved._tag, "Some");
      if (resolved._tag === "Some") {
        assert.equal(resolved.value.type, "request.resolved");
        assert.deepEqual(resolved.value.providerRefs, request.providerRefs);
      }
      const result = yield* Effect.promise(() => permission);
      assert.equal((result as PermissionResult).behavior, "allow");
      assert.equal(
        (result as Extract<PermissionResult, { behavior: "allow" }>).updatedPermissions?.length,
        1,
      );
      const replay = approvalCallback(harness)(
        toolName,
        {},
        {
          signal: new AbortController().signal,
          toolUseID: `tool-${toolName}`,
          requestId: `request-${toolName}`,
          agentID: "agent-mcp",
        },
      );
      const replayResult = yield* Effect.promise(() => replay);
      assert.equal((replayResult as PermissionResult).behavior, "allow");
      assert.equal(
        (replayResult as Extract<PermissionResult, { behavior: "allow" }>).updatedPermissions,
        undefined,
      );
      yield* adapter.stopSession(session.threadId);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect.each([
    { label: "foreground", background: false, decision: "accept" as const, behavior: "allow" },
    { label: "background", background: true, decision: "decline" as const, behavior: "deny" },
  ])(
    "preserves Agent callback correlation for $label work",
    ({ background, decision, behavior }) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "approval-required",
        });
        yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

        const permission = approvalCallback(harness)(
          "Agent",
          { description: "Redacted agent task", run_in_background: background },
          {
            signal: new AbortController().signal,
            toolUseID: `tool-agent-${background ? "background" : "foreground"}`,
            requestId: `request-agent-${background ? "background" : "foreground"}`,
            agentID: `agent-${background ? "background" : "foreground"}`,
          },
        );
        const opened = yield* Stream.runHead(adapter.streamEvents);
        assert.equal(opened._tag, "Some");
        if (opened._tag !== "Some") return;
        const request = requireRequest(opened.value);
        assert.equal(request.payload.requestType, "dynamic_tool_call");
        assert.deepEqual(request.providerRefs, {
          providerItemId: ProviderItemId.makeUnsafe(
            `tool-agent-${background ? "background" : "foreground"}`,
          ),
          providerRequestId: `request-agent-${background ? "background" : "foreground"}`,
          providerAgentId: `agent-${background ? "background" : "foreground"}`,
        });
        yield* adapter.respondToRequest(
          session.threadId,
          ApprovalRequestId.makeUnsafe(String(request.requestId)),
          decision,
        );
        const resolved = yield* Stream.runHead(adapter.streamEvents);
        assert.equal(resolved._tag, "Some");
        if (resolved._tag === "Some") {
          assert.equal(resolved.value.type, "request.resolved");
          assert.deepEqual(resolved.value.providerRefs, request.providerRefs);
        }
        const result = yield* Effect.promise(() => permission);
        assert.equal((result as PermissionResult).behavior, behavior);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );
});
