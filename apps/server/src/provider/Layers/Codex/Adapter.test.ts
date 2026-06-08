import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { Effect, Layer } from "effect";

import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { ProviderAdapterValidationError } from "../../Errors.ts";
import { CodexAdapter } from "../../Services/Codex/Adapter.ts";
import { makeCodexAdapterLive } from "./Adapter.ts";
import {
  FakeCodexManager,
  asThreadId,
  providerSessionDirectoryTestLayer,
} from "./Adapter.test.helpers.ts";

const validationManager = new FakeCodexManager();
const validationLayer = it.layer(
  makeCodexAdapterLive({ manager: validationManager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

validationLayer("CodexAdapterLive validation", (it) => {
  it.effect("returns validation error for non-codex provider on startSession", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .startSession({
          provider: "claudeAgent",
          threadId: asThreadId("thread-1"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.deepStrictEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: "codex",
          operation: "startSession",
          issue: "Expected provider 'codex' but received 'claudeAgent'.",
        }),
      );
      assert.equal(validationManager.startSessionImpl.mock.calls.length, 0);
    }),
  );
  it.effect("maps codex model options before starting a session", () =>
    Effect.gen(function* () {
      validationManager.startSessionImpl.mockClear();
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        provider: "codex",
        threadId: asThreadId("thread-1"),
        modelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
          options: {
            fastMode: true,
          },
        },
        runtimeMode: "full-access",
      });

      assert.deepStrictEqual(validationManager.startSessionImpl.mock.calls[0]?.[0], {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        providerRuntimeExecutionTargetId: "local",
        workspaceExecutionTargetId: "local",
        executionTargetId: "local",
        binaryPath: "codex",
        model: "gpt-5.3-codex",
        serviceTier: "fast",
        runtimeMode: "full-access",
      });
    }),
  );

  it.effect("forwards remote execution targets to the codex manager", () =>
    Effect.gen(function* () {
      validationManager.startSessionImpl.mockClear();
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        provider: "codex",
        threadId: asThreadId("thread-remote"),
        executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        cwd: "/workspace/project",
        runtimeMode: "full-access",
      });

      const startInput = validationManager.startSessionImpl.mock.calls[0]?.[0];
      assert.equal(startInput?.provider, "codex");
      assert.equal(startInput?.threadId, asThreadId("thread-remote"));
      assert.equal(startInput?.providerRuntimeExecutionTargetId, "local");
      assert.equal(
        startInput?.workspaceExecutionTargetId,
        "ssh:host=devbox&user=root&port=22&auth=ssh-key",
      );
      assert.equal(startInput?.executionTargetId, "ssh:host=devbox&user=root&port=22&auth=ssh-key");
      assert.equal(startInput?.binaryPath, "codex");
      assert.equal(startInput?.runtimeMode, "full-access");
      assert.equal(typeof startInput?.cwd, "string");
      assert.notEqual(startInput?.cwd, "/workspace/project");
      expect(startInput?.configArgs?.[0]).toBe("-c");
      expect(startInput?.configArgs?.[1]).toBe("app.default_tools_enabled=false");
      expect(startInput?.configArgs?.[2]).toBe("-c");
      expect(startInput?.configArgs?.[3]).toContain("mcp_servers.bigbud_remote_workspace.command=");
      expect(startInput?.developerInstructions).toContain("Bigbud remote workspace mode");
    }),
  );
});
