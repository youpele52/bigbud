import { readFile, stat } from "node:fs/promises";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ApprovalRequestId, ThreadId } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";

import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { CliProxyAdapter } from "../../Services/CliProxy/Adapter.ts";
import { CliProxyLifecycle } from "../../Services/CliProxy/Lifecycle.ts";
import { CLAUDE_HARNESS_CAPABILITIES } from "../Claude/Adapter.types.ts";
import { FakeClaudeQuery } from "../Claude/Adapter.test.helpers.query.ts";
import { makeCliProxyAdapterLive } from "./Adapter.ts";

const threadId = ThreadId.makeUnsafe("proxy-child-owner");

function harness(failStart = false) {
  const query = new FakeClaudeQuery();
  let options: Options | undefined;
  const layer = makeCliProxyAdapterLive({
    createQuery: (input) => {
      options = input.options;
      if (failStart) throw new Error("simulated spawn failure");
      return query;
    },
    resolveRuntimeConfig: () =>
      Effect.succeed({
        config: {
          baseUrl: new URL("http://127.0.0.1:8317"),
          apiKey: "test",
          configPath: "/tmp/test",
        },
        models: [{ id: "wire-model", name: "Wire model" }],
        harness: {
          binaryPath: "claude",
          capabilities: CLAUDE_HARNESS_CAPABILITIES,
          protectedSettingsEnvironment: { ANTHROPIC_AUTH_TOKEN: "private-test-token" },
          environment: { ANTHROPIC_AUTH_TOKEN: "private-test-token" },
        },
      }),
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest("/tmp/proxy-child-test", "/tmp")),
    Layer.provideMerge(
      ServerSettingsService.layerTest({
        providers: {
          claudeAgent: {
            maxSubagentSpawnDepth: 2,
            maxConcurrentSubagents: 3,
            rollout: { forwardedSubagentText: true },
          },
        },
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(CliProxyLifecycle, {
        isClaudeRunnable: async () => ({ _tag: "available" }) as const,
        activate: async () => ({ _tag: "started", reused: false }) as const,
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { query, layer, options: () => options };
}

describe("CLIProxy shared Claude providerSubagent lifecycle", () => {
  for (const failStart of [false, true]) {
    it.effect(
      `cleans private settings on ${failStart ? "spawn failure" : "layer disposal"}`,
      () => {
        const test = harness(failStart);
        const start = Effect.gen(function* () {
          const adapter = yield* CliProxyAdapter;
          const result = yield* Effect.result(
            adapter.startSession({
              threadId,
              provider: "cliProxy",
              runtimeMode: "approval-required",
              modelSelection: { provider: "cliProxy", model: "wire-model" },
            }),
          );
          assert.equal(result._tag, failStart ? "Failure" : "Success");
          if (!failStart) {
            const contents = yield* Effect.promise(() =>
              readFile(String(test.options()?.settings), "utf8"),
            );
            assert.equal(JSON.parse(contents).env.ANTHROPIC_AUTH_TOKEN, "private-test-token");
          }
        }).pipe(Effect.provide(test.layer));
        return Effect.gen(function* () {
          yield* start;
          const missing = yield* Effect.promise(() =>
            stat(String(test.options()?.settings)).then(
              () => false,
              () => true,
            ),
          );
          assert.equal(missing, true);
        });
      },
    );
  }

  it.effect("keeps explicit SDK approval requests as user asks, including full access", () => {
    const test = harness();
    return Effect.gen(function* () {
      const adapter = yield* CliProxyAdapter;
      const opened = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "request.opened"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId,
        provider: "cliProxy",
        runtimeMode: "full-access",
        modelSelection: { provider: "cliProxy", model: "wire-model" },
      });
      assert.equal(test.options()?.includeHookEvents, true);
      assert.equal(test.options()?.forwardSubagentText, true);
      assert.equal(test.options()?.env?.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, "2");
      assert.equal(test.options()?.env?.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, "3");
      const canUseTool = test.options()?.canUseTool;
      assert.isDefined(canUseTool);
      const result = yield* Effect.promise(() =>
        canUseTool(
          "Bash",
          { command: "git status" },
          {
            requestId: "explicit-ask",
            toolUseID: "tool",
            signal: new AbortController().signal,
          },
        ),
      ).pipe(Effect.forkChild);
      const requests = yield* Fiber.join(opened);
      const request = requests[0];
      assert.equal(request?.provider, "cliProxy");
      assert.equal(request?.type, "request.opened");
      if (request?.type !== "request.opened") return;
      assert.isDefined(request.requestId);
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.makeUnsafe(String(request.requestId)),
        "decline",
      );
      const decision = yield* Fiber.join(result);
      assert.isNotNull(decision);
      assert.equal(decision.behavior, "deny");
      const settingsPath = String(test.options()?.settings);
      assert.equal((yield* Effect.promise(() => stat(settingsPath))).mode & 0o777, 0o600);
      yield* adapter.stopSession(threadId);
      assert.equal(
        yield* Effect.promise(() =>
          stat(settingsPath).then(
            () => false,
            () => true,
          ),
        ),
        true,
      );
    }).pipe(Effect.provide(test.layer));
  });
  for (const taskType of ["local_agent", "local_bash"]) {
    it.effect(`projects ${taskType} and enforces shared stop ownership`, () => {
      const { query, layer } = harness();
      return Effect.gen(function* () {
        const adapter = yield* CliProxyAdapter;
        const seen = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "task.updated"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession({
          threadId,
          provider: "cliProxy",
          runtimeMode: "approval-required",
          modelSelection: { provider: "cliProxy", model: "wire-model" },
        });
        yield* adapter.sendTurn({ threadId, input: "delegate", attachments: [] });
        query.emit({
          type: "system",
          subtype: "task_started",
          session_id: "session",
          uuid: "start",
          task_id: "child",
          tool_use_id: "spawn",
          task_type: taskType,
          description: "Review",
        } as unknown as SDKMessage);
        const events = yield* Fiber.join(seen);
        const event = events[0];
        assert.equal(event?.provider, "cliProxy");
        assert.equal(event?.type, "task.updated");
        if (event?.type === "task.updated") {
          assert.equal(
            event.payload.kind,
            taskType === "local_agent" ? "providerSubagent" : "task",
          );
        }
        const stop = adapter.stopSubagent;
        assert.isDefined(stop);
        const unknown = yield* Effect.result(stop(threadId, "someone-elses-child"));
        assert.equal(unknown._tag, "Failure");
        assert.deepEqual(query.stopTaskCalls, []);
        const result = yield* Effect.result(stop(threadId, "child"));
        assert.equal(result._tag, taskType === "local_agent" ? "Success" : "Failure");
        assert.deepEqual(query.stopTaskCalls, taskType === "local_agent" ? ["child"] : []);
        yield* adapter.stopSession(threadId);
      }).pipe(Effect.provide(layer));
    });
  }
});
