import { assert, it as effectIt, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { CliProxyAdapter } from "../../Services/CliProxy/Adapter.ts";
import { CliProxyLifecycle } from "../../Services/CliProxy/Lifecycle.ts";
import { FakeClaudeQuery } from "../Claude/Adapter.test.helpers.ts";
import type { ClaudeAdapterLiveOptions } from "../Claude/Adapter.ts";
import {
  makeCliProxyAdapterLive,
  toClaudeSendTurnInput,
  toClaudeSessionStartInput,
} from "./Adapter.ts";

describe("CLIProxy Claude input translation", () => {
  it("translates both provider identities when starting a session", () => {
    expect(
      toClaudeSessionStartInput({
        threadId: "thread-1",
        provider: "cliProxy",
        modelSelection: { provider: "cliProxy", model: "gpt-5-codex" },
        runtimeMode: "full-access",
      } as never),
    ).toMatchObject({
      provider: "claudeAgent",
      modelSelection: { provider: "claudeAgent", model: "gpt-5-codex" },
    });
  });

  it("translates CLIProxy model selections when sending a turn", () => {
    expect(
      toClaudeSendTurnInput({
        threadId: "thread-1",
        input: "Hello",
        modelSelection: { provider: "cliProxy", model: "gpt-5-codex" },
      } as never),
    ).toMatchObject({
      modelSelection: { provider: "claudeAgent", model: "gpt-5-codex" },
    });
  });
});

const resolveRuntimeConfig = vi.fn(
  (input: {
    readonly threadId: string;
    readonly modelSelection?: { readonly provider?: string };
  }) =>
    Effect.succeed({
      config: {
        baseUrl: new URL("http://127.0.0.1:8317"),
        apiKey: `token-${input.threadId}`,
        configPath: "/tmp/config.yaml",
      },
      models: [{ id: "gpt-5-codex", name: "GPT-5 Codex" }],
      selectedModel: "gpt-5-codex",
      harness: {
        binaryPath: "claude",
        settingSources: [] as const,
        environment: {
          PATH: "/usr/bin",
          HOME: "/tmp/home",
          ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
          ANTHROPIC_AUTH_TOKEN: `token-${input.threadId}`,
        },
      },
    }),
);
const createQuery = vi.fn(
  (_input: Parameters<NonNullable<ClaudeAdapterLiveOptions["createQuery"]>>[0]) =>
    new FakeClaudeQuery(),
);
const adapterLayer = effectIt.layer(
  makeCliProxyAdapterLive({
    resolveRuntimeConfig: resolveRuntimeConfig as never,
    createQuery,
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest("/tmp/cliproxy-adapter-test", "/tmp")),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      Layer.succeed(CliProxyLifecycle, {
        isClaudeRunnable: async () => ({ _tag: "available" }) as const,
        activate: async () => ({ _tag: "started", strategy: "direct" }) as const,
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

adapterLayer("CliProxyAdapterLive", (it) => {
  it.effect("resolves an isolated Claude-compatible harness for every session", () =>
    Effect.gen(function* () {
      const adapter = yield* CliProxyAdapter;
      const beforeResolve = resolveRuntimeConfig.mock.calls.length;
      const beforeQueries = createQuery.mock.calls.length;

      const session = yield* adapter.startSession({
        threadId: "thread-cli-proxy-harness",
        provider: "cliProxy",
        modelSelection: { provider: "cliProxy", model: "gpt-5-codex" },
        runtimeMode: "full-access",
      } as never);

      assert.equal(session.provider, "cliProxy");
      assert.equal(resolveRuntimeConfig.mock.calls.length, beforeResolve + 1);
      assert.equal(
        resolveRuntimeConfig.mock.calls.at(-1)?.[0].modelSelection?.provider,
        "cliProxy",
      );
      assert.equal(createQuery.mock.calls.length, beforeQueries + 1);
      const options = createQuery.mock.calls.at(-1)?.[0].options;
      assert.equal(options?.model, "gpt-5-codex");
      assert.deepEqual(options?.settingSources, []);
      assert.equal(options?.env?.ANTHROPIC_AUTH_TOKEN, "token-thread-cli-proxy-harness");
      assert.equal(options?.env?.ANTHROPIC_API_KEY, undefined);
      assert.deepEqual(adapter.capabilities, {
        sessionModelSwitch: "unsupported",
        sessionRecovery: "unsupported",
        conversationRewind: "unsupported",
        conversationFork: "unsupported",
      });
      yield* adapter.stopAll();
    }),
  );

  it.effect("rejects recovery before constructing a Claude query", () =>
    Effect.gen(function* () {
      const adapter = yield* CliProxyAdapter;
      const beforeQueries = createQuery.mock.calls.length;
      const result = yield* adapter
        .startSession({
          threadId: "thread-cli-proxy-recovery",
          provider: "cliProxy",
          modelSelection: { provider: "cliProxy", model: "gpt-5-codex" },
          resumeCursor: { sessionId: "old" },
          runtimeMode: "full-access",
        } as never)
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "ProviderAdapterValidationError");
      }
      assert.equal(createQuery.mock.calls.length, beforeQueries);
    }),
  );

  it.effect("requires a cliProxy model selection at the adapter boundary", () =>
    Effect.gen(function* () {
      const adapter = yield* CliProxyAdapter;
      const beforeQueries = createQuery.mock.calls.length;
      const result = yield* adapter
        .startSession({
          threadId: "thread-cli-proxy-missing-model",
          provider: "cliProxy",
          runtimeMode: "full-access",
        } as never)
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "ProviderAdapterValidationError");
        if (result.failure._tag === "ProviderAdapterValidationError") {
          assert.match(result.failure.issue, /modelSelection\.provider/);
        }
      }
      assert.equal(createQuery.mock.calls.length, beforeQueries);
    }),
  );

  it.effect("rejects model switching before forwarding the turn", () =>
    Effect.gen(function* () {
      const adapter = yield* CliProxyAdapter;
      const threadId = "thread-cli-proxy-model-switch";
      yield* adapter.startSession({
        threadId,
        provider: "cliProxy",
        modelSelection: { provider: "cliProxy", model: "gpt-5-codex" },
        runtimeMode: "full-access",
      } as never);
      const beforeQueries = createQuery.mock.calls.length;
      const result = yield* adapter
        .sendTurn({
          threadId,
          input: "switch",
          modelSelection: { provider: "cliProxy", model: "other-model" },
        } as never)
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "ProviderAdapterValidationError");
      }
      assert.equal(createQuery.mock.calls.length, beforeQueries);
      yield* adapter.stopAll();
    }),
  );
});
