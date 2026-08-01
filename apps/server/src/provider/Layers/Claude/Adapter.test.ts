import { existsSync } from "node:fs";
import path from "node:path";

import { describe, it, assert } from "@effect/vitest";
import { Effect, Random } from "effect";

import { ProviderAdapterValidationError } from "../../Errors.ts";
import { ClaudeAdapter } from "../../Services/Claude/Adapter.ts";
import { resolveNodeExecutable } from "../../../utils/nodeExecutable.ts";
import {
  THREAD_ID,
  makeDeterministicRandomService,
  makeHarness,
  readFirstPromptText,
} from "./Adapter.test.helpers.ts";

describe("ClaudeAdapterLive", () => {
  it.effect("returns validation error for non-claude provider on startSession", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const result = yield* adapter
        .startSession({ threadId: THREAD_ID, provider: "codex", runtimeMode: "full-access" })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }
      assert.deepEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: "claudeAgent",
          operation: "startSession",
          issue: "Expected provider 'claudeAgent' but received 'codex'.",
        }),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("runs remote Claude workspaces through a local MCP bridge", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        executionTargetId: "ssh:host=devbox&user=root&port=22",
        cwd: "/srv/project",
        runtimeMode: "approval-required",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(session.cwd, "/srv/project");
      assert.equal(session.providerRuntimeExecutionTargetId, "local");
      assert.equal(session.workspaceExecutionTargetId, "ssh:host=devbox&user=root&port=22");
      assert.equal(createInput?.options.permissionMode, undefined);
      assert.equal(createInput?.options.cwd?.includes("bigbud-claude-remote-workspace-"), true);
      assert.deepEqual(createInput?.options.tools, [
        "AskUserQuestion",
        "TaskCreate",
        "TaskUpdate",
        "TaskGet",
        "TaskList",
        "TodoWrite",
        "ExitPlanMode",
      ]);
      assert.equal(createInput?.options.includeHookEvents, true);
      assert.equal(createInput?.options.agentProgressSummaries, true);
      assert.deepEqual(createInput?.options.allowedTools, [
        "mcp__bigbud_remote_workspace__read",
        "mcp__bigbud_remote_workspace__grep",
        "mcp__bigbud_remote_workspace__glob",
        "mcp__bigbud_remote_workspace__list",
        "mcp__bigbud_orchestration__browser",
        "mcp__bigbud_orchestration__computer_use",
        "mcp__bigbud_orchestration__rename_thread",
        "mcp__bigbud_orchestration__archive_thread",
        "mcp__bigbud_orchestration__send_thread_message",
        "mcp__bigbud_orchestration__get_thread_status",
        "mcp__bigbud_orchestration__list_threads",
        "mcp__bigbud_orchestration__list_pinned_threads",
        "mcp__bigbud_orchestration__pin_thread",
        "mcp__bigbud_orchestration__unpin_thread",
      ]);
      assert.deepEqual(createInput?.options.additionalDirectories, undefined);
      const remoteWorkspaceServer = createInput?.options.mcpServers?.bigbud_remote_workspace;
      assert.equal(
        !!remoteWorkspaceServer &&
          (!("type" in remoteWorkspaceServer) || remoteWorkspaceServer.type === "stdio"),
        true,
      );
      if (
        !remoteWorkspaceServer ||
        ("type" in remoteWorkspaceServer && remoteWorkspaceServer.type !== "stdio")
      ) {
        return;
      }
      assert.equal(remoteWorkspaceServer.command, resolveNodeExecutable());
      assert.deepEqual(remoteWorkspaceServer.args, [
        path.join(createInput?.options.cwd ?? "", ".bigbud/remote-workspace-mcp-server.mjs"),
      ]);

      const syntheticCwd = createInput?.options.cwd;
      assert.equal(typeof syntheticCwd, "string");
      if (!syntheticCwd) {
        return;
      }

      assert.equal(existsSync(syntheticCwd), true);
      yield* adapter.stopSession(THREAD_ID);
      assert.equal(existsSync(syntheticCwd), false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards claude effort levels into query options", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            effort: "max",
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "max");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("falls back to default effort when unsupported max is requested for Sonnet 4.6", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            effort: "max",
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "high");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores adaptive effort for Haiku 4.5", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-haiku-4-5",
          options: {
            effort: "high",
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards Claude thinking toggle into SDK settings for Haiku 4.5", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-haiku-4-5",
          options: {
            thinking: false,
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, {
        alwaysThinkingEnabled: false,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores Claude thinking toggle for non-Haiku models", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            thinking: false,
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.settings, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards claude fast mode into SDK settings", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            fastMode: true,
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, {
        fastMode: true,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores claude fast mode for non-opus models", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            fastMode: true,
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.settings, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("treats ultrathink as a prompt keyword instead of a session effort", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            effort: "ultrathink",
          },
        },
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Investigate the edge cases",
        attachments: [],
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            effort: "ultrathink",
          },
        },
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "high");
      const promptText = yield* Effect.promise(() => readFirstPromptText(createInput));
      assert.equal(promptText, "Ultrathink:\nInvestigate the edge cases");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});
