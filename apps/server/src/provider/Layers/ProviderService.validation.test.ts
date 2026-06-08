import { assert } from "@effect/vitest";
import { Effect, Option } from "effect";
import type { ProviderSession } from "@bigbud/contracts";
import { ProviderSessionStartInput } from "@bigbud/contracts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { asThreadId, makeProviderServiceLayer } from "./ProviderService.test.helpers.ts";

const validation = makeProviderServiceLayer();
validation.layer("ProviderServiceLive validation", (it) => {
  it.effect("returns ProviderValidationError for invalid input payloads", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const failure = yield* Effect.result(
        provider.startSession(asThreadId("thread-validation"), {
          threadId: asThreadId("thread-validation"),
          provider: "invalid-provider",
          runtimeMode: "full-access",
        } as never),
      );

      assert.equal(failure._tag, "Failure");
      if (failure._tag !== "Failure") {
        return;
      }
      assert.equal(failure.failure._tag, "ProviderValidationError");
      if (failure.failure._tag !== "ProviderValidationError") {
        return;
      }
      assert.equal(failure.failure.operation, "ProviderService.startSession");
      assert.equal(failure.failure.issue.includes("invalid-provider"), true);
    }),
  );

  it.effect("accepts startSession when adapter has not emitted provider thread id yet", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      validation.codex.startSession.mockImplementationOnce((input: ProviderSessionStartInput) =>
        Effect.sync(() => {
          const now = new Date().toISOString();
          return {
            provider: "codex",
            status: "ready",
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            cwd: input.cwd ?? process.cwd(),
            createdAt: now,
            updatedAt: now,
          } satisfies ProviderSession;
        }),
      );

      const session = yield* provider.startSession(asThreadId("thread-missing"), {
        provider: "codex",
        threadId: asThreadId("thread-missing"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      assert.equal(session.threadId, asThreadId("thread-missing"));

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, session.threadId);
      }
    }),
  );

  it.effect("allows remote codex sessions and persists their execution target", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      validation.codex.startSession.mockImplementationOnce((input: ProviderSessionStartInput) =>
        Effect.sync(() => {
          const now = new Date().toISOString();
          return {
            provider: "codex",
            status: "ready",
            threadId: input.threadId,
            executionTargetId: input.executionTargetId,
            runtimeMode: input.runtimeMode,
            cwd: input.cwd ?? "/root/project",
            createdAt: now,
            updatedAt: now,
          } satisfies ProviderSession;
        }),
      );

      const session = yield* provider.startSession(asThreadId("thread-remote-codex"), {
        provider: "codex",
        threadId: asThreadId("thread-remote-codex"),
        executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        cwd: "/root/project",
        runtimeMode: "full-access",
      });

      assert.equal(session.executionTargetId, "ssh:host=devbox&user=root&port=22&auth=ssh-key");

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(
          runtime.value.providerRuntimeExecutionTargetId,
          "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        );
        assert.equal(
          runtime.value.workspaceExecutionTargetId,
          "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        );
        assert.equal(
          runtime.value.executionTargetId,
          "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        );
      }
    }),
  );

  it.effect("allows remote opencode sessions and persists their execution target", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      validation.opencode.startSession.mockImplementationOnce((input: ProviderSessionStartInput) =>
        Effect.sync(() => {
          const now = new Date().toISOString();
          return {
            provider: "opencode",
            status: "ready",
            threadId: input.threadId,
            executionTargetId: input.executionTargetId,
            runtimeMode: input.runtimeMode,
            cwd: input.cwd ?? "/root/project",
            createdAt: now,
            updatedAt: now,
          } satisfies ProviderSession;
        }),
      );

      const session = yield* provider.startSession(asThreadId("thread-remote-opencode"), {
        provider: "opencode",
        threadId: asThreadId("thread-remote-opencode"),
        executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        cwd: "/root/project",
        runtimeMode: "full-access",
      });

      assert.equal(session.executionTargetId, "ssh:host=devbox&user=root&port=22&auth=ssh-key");

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(
          runtime.value.providerRuntimeExecutionTargetId,
          "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        );
        assert.equal(
          runtime.value.workspaceExecutionTargetId,
          "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        );
        assert.equal(
          runtime.value.executionTargetId,
          "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        );
      }
    }),
  );

  it.effect("allows remote pi sessions and persists their execution target", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      validation.pi.startSession.mockImplementationOnce((input: ProviderSessionStartInput) =>
        Effect.sync(() => {
          const now = new Date().toISOString();
          return {
            provider: "pi",
            status: "ready",
            threadId: input.threadId,
            providerRuntimeExecutionTargetId: input.providerRuntimeExecutionTargetId,
            workspaceExecutionTargetId: input.workspaceExecutionTargetId,
            executionTargetId: input.executionTargetId,
            runtimeMode: input.runtimeMode,
            cwd: input.cwd ?? "/root/project",
            createdAt: now,
            updatedAt: now,
          } satisfies ProviderSession;
        }),
      );

      const session = yield* provider.startSession(asThreadId("thread-remote-pi"), {
        provider: "pi",
        threadId: asThreadId("thread-remote-pi"),
        executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        cwd: "/root/project",
        runtimeMode: "full-access",
      });

      assert.equal(session.executionTargetId, "ssh:host=devbox&user=root&port=22&auth=ssh-key");
      assert.equal(session.providerRuntimeExecutionTargetId, "local");
      assert.equal(
        session.workspaceExecutionTargetId,
        "ssh:host=devbox&user=root&port=22&auth=ssh-key",
      );
      assert.deepStrictEqual(validation.pi.startSession.mock.calls.at(-1)?.[0], {
        provider: "pi",
        threadId: asThreadId("thread-remote-pi"),
        providerRuntimeExecutionTargetId: "local",
        workspaceExecutionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        cwd: "/root/project",
        runtimeMode: "full-access",
      });

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.providerRuntimeExecutionTargetId, "local");
        assert.equal(
          runtime.value.workspaceExecutionTargetId,
          "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        );
        assert.equal(
          runtime.value.executionTargetId,
          "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        );
      }
    }),
  );

  it.effect("defaults remote Claude sessions to a local provider runtime", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      validation.claude.startSession.mockImplementationOnce((input: ProviderSessionStartInput) =>
        Effect.sync(() => {
          const now = new Date().toISOString();
          return {
            provider: "claudeAgent",
            status: "ready",
            threadId: input.threadId,
            providerRuntimeExecutionTargetId: input.providerRuntimeExecutionTargetId,
            workspaceExecutionTargetId: input.workspaceExecutionTargetId,
            executionTargetId: input.executionTargetId,
            runtimeMode: input.runtimeMode,
            cwd: input.cwd ?? "/root/project",
            createdAt: now,
            updatedAt: now,
          } satisfies ProviderSession;
        }),
      );

      const session = yield* provider.startSession(asThreadId("thread-remote-claude"), {
        provider: "claudeAgent",
        threadId: asThreadId("thread-remote-claude"),
        executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        cwd: "/root/project",
        runtimeMode: "approval-required",
      });

      assert.equal(session.providerRuntimeExecutionTargetId, "local");
      assert.equal(
        session.workspaceExecutionTargetId,
        "ssh:host=devbox&user=root&port=22&auth=ssh-key",
      );
      assert.deepStrictEqual(validation.claude.startSession.mock.calls.at(-1)?.[0], {
        provider: "claudeAgent",
        threadId: asThreadId("thread-remote-claude"),
        providerRuntimeExecutionTargetId: "local",
        workspaceExecutionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        cwd: "/root/project",
        runtimeMode: "approval-required",
      });

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.providerRuntimeExecutionTargetId, "local");
        assert.equal(
          runtime.value.workspaceExecutionTargetId,
          "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        );
      }
    }),
  );

  it.effect("defaults remote Copilot sessions to a local provider runtime", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      validation.copilot.startSession.mockImplementationOnce((input: ProviderSessionStartInput) =>
        Effect.sync(() => {
          const now = new Date().toISOString();
          return {
            provider: "copilot",
            status: "ready",
            threadId: input.threadId,
            providerRuntimeExecutionTargetId: input.providerRuntimeExecutionTargetId,
            workspaceExecutionTargetId: input.workspaceExecutionTargetId,
            executionTargetId: input.executionTargetId,
            runtimeMode: input.runtimeMode,
            cwd: input.cwd ?? "/root/project",
            createdAt: now,
            updatedAt: now,
          } satisfies ProviderSession;
        }),
      );

      const session = yield* provider.startSession(asThreadId("thread-remote-copilot"), {
        provider: "copilot",
        threadId: asThreadId("thread-remote-copilot"),
        executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        cwd: "/root/project",
        runtimeMode: "approval-required",
      });

      assert.equal(session.providerRuntimeExecutionTargetId, "local");
      assert.equal(
        session.workspaceExecutionTargetId,
        "ssh:host=devbox&user=root&port=22&auth=ssh-key",
      );
      assert.deepStrictEqual(validation.copilot.startSession.mock.calls.at(-1)?.[0], {
        provider: "copilot",
        threadId: asThreadId("thread-remote-copilot"),
        providerRuntimeExecutionTargetId: "local",
        workspaceExecutionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        cwd: "/root/project",
        runtimeMode: "approval-required",
      });

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.providerRuntimeExecutionTargetId, "local");
        assert.equal(
          runtime.value.workspaceExecutionTargetId,
          "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        );
      }
    }),
  );

  it.effect("rejects unsupported remote provider runtimes", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const failure = yield* Effect.result(
        provider.startSession(asThreadId("thread-remote-copilot"), {
          provider: "copilot",
          threadId: asThreadId("thread-remote-copilot"),
          providerRuntimeExecutionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
          workspaceExecutionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
          executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
          cwd: "/root/project",
          runtimeMode: "full-access",
        }),
      );

      assert.equal(failure._tag, "Failure");
      if (failure._tag !== "Failure") {
        return;
      }

      assert.equal(failure.failure._tag, "ProviderValidationError");
      if (failure.failure._tag !== "ProviderValidationError") {
        return;
      }

      assert.equal(
        failure.failure.issue,
        "Provider sessions is not implemented for provider 'copilot' on execution target 'ssh:host=devbox&user=root&port=22&auth=ssh-key' yet.",
      );
    }),
  );
});
