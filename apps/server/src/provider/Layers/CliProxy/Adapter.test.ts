import { assert, it as effectIt, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "vitest";
import { Effect, Fiber, Layer, Stream } from "effect";

import { ThreadId } from "@bigbud/contracts";
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
        sessionRecovery: "fresh-restart",
        conversationRewind: "unsupported",
        conversationFork: "unsupported",
      });
      yield* adapter.stopAll();
    }),
  );

  it.effect("starts a fresh query when recovery has no native cursor", () =>
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

      assert.equal(result._tag, "Success");
      assert.equal(createQuery.mock.calls.length, beforeQueries + 1);
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

  it.effect("keeps two normal turns on one persistent delegated query", () =>
    Effect.gen(function* () {
      const adapter = yield* CliProxyAdapter;
      const threadId = ThreadId.makeUnsafe("thread-cli-proxy-two-turns");
      const beforeQueries = createQuery.mock.calls.length;
      const session = yield* adapter.startSession({
        threadId,
        provider: "cliProxy",
        modelSelection: { provider: "cliProxy", model: "gpt-5-codex" },
        runtimeMode: "full-access",
      } as never);
      const query = createQuery.mock.results.at(-1)?.value as FakeClaudeQuery;

      const firstTurn = yield* adapter.sendTurn({
        threadId,
        input: "first",
        modelSelection: { provider: "cliProxy", model: "gpt-5-codex" },
        attachments: [],
      } as never);
      const firstCompletedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);
      query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "cli-proxy-session",
        uuid: "cli-proxy-result-1",
      } as never);
      const firstCompleted = yield* Fiber.join(firstCompletedFiber);
      assert.equal(firstCompleted._tag, "Some");

      const secondTurn = yield* adapter.sendTurn({
        threadId,
        input: "second",
        attachments: [],
      } as never);
      const secondCompletedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);
      query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "cli-proxy-session",
        uuid: "cli-proxy-result-2",
      } as never);
      const secondCompleted = yield* Fiber.join(secondCompletedFiber);

      assert.equal(secondCompleted._tag, "Some");
      assert.notEqual(String(firstTurn.turnId), String(secondTurn.turnId));
      assert.equal(createQuery.mock.calls.length, beforeQueries + 1);
      assert.equal(yield* adapter.hasSession(session.threadId), true);
      yield* adapter.stopAll();
    }),
  );

  it.effect("drops delegated session ownership before starting a fresh recovery query", () =>
    Effect.gen(function* () {
      const adapter = yield* CliProxyAdapter;
      const threadId = ThreadId.makeUnsafe("thread-cli-proxy-exit-recovery");
      yield* adapter.startSession({
        threadId,
        provider: "cliProxy",
        modelSelection: { provider: "cliProxy", model: "gpt-5-codex" },
        runtimeMode: "full-access",
      } as never);
      const firstQuery = createQuery.mock.results.at(-1)?.value as FakeClaudeQuery;
      const exitedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "session.exited",
      ).pipe(Stream.runHead, Effect.forkChild);

      firstQuery.finish();
      const exited = yield* Fiber.join(exitedFiber);
      assert.equal(exited._tag, "Some");
      assert.equal(yield* adapter.hasSession(threadId), false);
      for (
        let attempt = 0;
        attempt < 200 && (yield* adapter.listSessions()).length > 0;
        attempt += 1
      ) {
        yield* Effect.yieldNow;
      }
      assert.deepEqual(yield* adapter.listSessions(), []);

      yield* adapter.startSession({
        threadId,
        provider: "cliProxy",
        modelSelection: { provider: "cliProxy", model: "gpt-5-codex" },
        runtimeMode: "full-access",
      } as never);
      const secondQuery = createQuery.mock.results.at(-1)?.value as FakeClaudeQuery;
      assert.equal(yield* adapter.hasSession(threadId), true);
      assert.equal((yield* adapter.listSessions()).length, 1);

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "next request only",
        attachments: [],
      } as never);
      const completedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);
      secondQuery.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "cli-proxy-session-recovered",
        uuid: "cli-proxy-result-recovered",
      } as never);
      const completed = yield* Fiber.join(completedFiber);
      assert.equal(completed._tag, "Some");
      assert.equal(String(turn.threadId), threadId);
      yield* adapter.stopAll();
    }),
  );
});
