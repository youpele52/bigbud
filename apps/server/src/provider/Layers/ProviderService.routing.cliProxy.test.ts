import { assert } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";
import { Effect } from "effect";

import { ProviderUnsupportedError, ProviderValidationError } from "../Errors.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { asThreadId, makeProviderServiceLayer } from "./ProviderService.test.helpers.ts";

const excluded = makeProviderServiceLayer({
  isProviderComposed: (provider) => provider !== "cliProxy",
});

excluded.layer("ProviderServiceLive excluded CLIProxy routing", (it) => {
  it.effect("rejects direct starts before invoking the CLIProxy adapter", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const priorStarts = excluded.cliProxy.startSession.mock.calls.length;
      const threadId = asThreadId("thread-cli-proxy-excluded-start");

      const result = yield* provider
        .startSession(threadId, {
          provider: "cliProxy",
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assertFailure(
        result,
        new ProviderValidationError({
          operation: "ProviderService.startSession",
          issue: "Provider 'cliProxy' is unavailable in this bigbud build.",
        }),
      );
      assert.equal(excluded.cliProxy.startSession.mock.calls.length, priorStarts);
    }),
  );

  it.effect("rejects persisted routes before consuming CLIProxy resume state", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-cli-proxy-excluded-binding");
      const priorHasSessionCalls = excluded.cliProxy.hasSession.mock.calls.length;
      const priorStarts = excluded.cliProxy.startSession.mock.calls.length;

      yield* directory.upsert({
        provider: "cliProxy",
        threadId,
        resumeCursor: { sessionId: "cli-proxy-resume" },
        runtimePayload: { cwd: "/tmp/cli-proxy" },
      });

      const result = yield* provider
        .sendTurn({
          threadId,
          input: "resume",
          attachments: [],
        })
        .pipe(Effect.result);

      assertFailure(
        result,
        new ProviderValidationError({
          operation: "ProviderService.sendTurn",
          issue: "Provider 'cliProxy' is unavailable in this bigbud build.",
        }),
      );
      assert.equal(excluded.cliProxy.hasSession.mock.calls.length, priorHasSessionCalls);
      assert.equal(excluded.cliProxy.startSession.mock.calls.length, priorStarts);
    }),
  );

  it.effect("keeps core providers routable when CLIProxy is excluded", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-codex-with-cli-proxy-excluded");
      const session = yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, "codex");
    }),
  );
});

const recoveryUnsupported = makeProviderServiceLayer();

recoveryUnsupported.layer("ProviderServiceLive CLIProxy recovery capability", (it) => {
  it.effect("treats unsupported session recovery as authoritative", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-cli-proxy-unsupported-recovery");
      yield* directory.upsert({
        provider: "cliProxy",
        threadId,
        resumeCursor: { sessionId: "stale" },
        runtimePayload: {
          modelSelection: { provider: "cliProxy", model: "gpt-5-codex" },
        },
      });

      const result = yield* provider
        .sendTurn({ threadId, input: "recover", attachments: [] })
        .pipe(Effect.result);

      assertFailure(
        result,
        new ProviderValidationError({
          operation: "ProviderService.sendTurn",
          issue: "Provider 'cliProxy' does not support session recovery.",
        }),
      );
    }),
  );

  it.effect("does not reuse persisted recovery state for a fresh start", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-cli-proxy-fresh-start");
      yield* directory.upsert({
        provider: "cliProxy",
        threadId,
        resumeCursor: { sessionId: "stale" },
        runtimePayload: {},
      });

      yield* provider.startSession(threadId, {
        provider: "cliProxy",
        threadId,
        modelSelection: { provider: "cliProxy", model: "gpt-5-codex" },
        runtimeMode: "full-access",
      });
      const startInput = recoveryUnsupported.cliProxy.startSession.mock.calls.at(-1)?.[0];
      assert.equal(startInput?.resumeCursor, undefined);
    }),
  );
});

const freshRecovery = makeProviderServiceLayer({ cliProxySessionRecovery: "fresh-restart" });

freshRecovery.layer("ProviderServiceLive CLIProxy fresh recovery", (it) => {
  it.effect("starts a fresh session without forwarding uncertain native resume state", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-cli-proxy-fresh-recovery");
      yield* directory.upsert({
        provider: "cliProxy",
        threadId,
        resumeCursor: { sessionId: "native-claude-state" },
        runtimePayload: {
          modelSelection: { provider: "cliProxy", model: "gpt-5-codex" },
        },
      });

      yield* provider.sendTurn({ threadId, input: "recover", attachments: [] });

      const startInput = freshRecovery.cliProxy.startSession.mock.calls.at(-1)?.[0];
      assert.equal(startInput?.resumeCursor, undefined);
      assert.equal(startInput?.modelSelection?.provider, "cliProxy");
      assert.equal(startInput?.modelSelection?.model, "gpt-5-codex");
    }),
  );
});

const executionTargets = makeProviderServiceLayer();

executionTargets.layer("ProviderServiceLive provider execution targets", (it) => {
  it.effect("accepts local runtimes with remote workspaces for cliProxy and kilocode", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      for (const [providerKind, adapter] of [
        ["cliProxy", executionTargets.cliProxy] as const,
        ["kilocode", executionTargets.kilocode] as const,
      ]) {
        const threadId = asThreadId(`thread-${providerKind}-remote-workspace`);
        const session = yield* provider.startSession(threadId, {
          provider: providerKind,
          threadId,
          providerRuntimeExecutionTargetId: "local",
          workspaceExecutionTargetId: "ssh:devbox",
          runtimeMode: "full-access",
        });

        assert.equal(session.provider, providerKind);
        assert.equal(adapter.startSession.mock.calls.length, 1);
        yield* provider.stopSession({ threadId });
      }
    }),
  );

  it.effect("continues rejecting unsupported remote provider runtimes", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-cli-proxy-remote-runtime");
      const priorStarts = executionTargets.cliProxy.startSession.mock.calls.length;

      const result = yield* provider
        .startSession(threadId, {
          provider: "cliProxy",
          threadId,
          providerRuntimeExecutionTargetId: "ssh:provider",
          workspaceExecutionTargetId: "local",
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assertFailure(
        result,
        new ProviderValidationError({
          operation: "ProviderService.startSession",
          issue:
            "Provider sessions is not implemented for provider 'cliProxy' on execution target 'ssh:provider' yet.",
        }),
      );
      assert.equal(executionTargets.cliProxy.startSession.mock.calls.length, priorStarts);
    }),
  );
});

const settingsDisabled = makeProviderServiceLayer({
  settings: {
    providers: {
      cliProxy: { enabled: false },
    },
  },
});

settingsDisabled.layer("ProviderServiceLive settings-disabled CLIProxy routing", (it) => {
  it.effect("distinguishes settings-disabled CLIProxy from deployment exclusion", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const priorStarts = settingsDisabled.cliProxy.startSession.mock.calls.length;
      const threadId = asThreadId("thread-cli-proxy-settings-disabled");

      const result = yield* provider
        .startSession(threadId, {
          provider: "cliProxy",
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assertFailure(
        result,
        new ProviderValidationError({
          operation: "ProviderService.startSession",
          issue: "Provider 'cliProxy' is disabled in bigbud settings.",
        }),
      );
      assert.equal(settingsDisabled.cliProxy.startSession.mock.calls.length, priorStarts);
    }),
  );
});

const adapterAbsent = makeProviderServiceLayer({ includeCliProxyAdapter: false });

adapterAbsent.layer("ProviderServiceLive missing CLIProxy adapter routing", (it) => {
  it.effect("preserves the unsupported-provider error when composition is present", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-cli-proxy-adapter-absent");
      const result = yield* provider
        .startSession(threadId, {
          provider: "cliProxy",
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assertFailure(result, new ProviderUnsupportedError({ provider: "cliProxy" }));
    }),
  );
});
