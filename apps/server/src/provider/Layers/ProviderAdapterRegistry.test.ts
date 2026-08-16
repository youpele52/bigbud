import type { ProviderKind } from "@bigbud/contracts";
import { it, assert, vi } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";

import { Effect, Layer, Stream } from "effect";

import { ClaudeAdapter, ClaudeAdapterShape } from "../Services/Claude/Adapter.ts";
import type { CliProxyAdapterShape } from "../Services/CliProxy/Adapter.ts";
import { CopilotAdapter, CopilotAdapterShape } from "../Services/Copilot/Adapter.ts";
import { CodexAdapter, CodexAdapterShape } from "../Services/Codex/Adapter.ts";
import { OpencodeAdapter, OpencodeAdapterShape } from "../Services/Opencode/Adapter.ts";
import { PiAdapter, PiAdapterShape } from "../Services/Pi/Adapter.ts";
import { CursorAdapter, CursorAdapterShape } from "../Services/Cursor/Adapter.ts";
import { DevinAdapter, DevinAdapterShape } from "../Services/Devin/Adapter.ts";
import { KilocodeAdapter, KilocodeAdapterShape } from "../Services/Kilocode/Adapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import {
  ProviderAdapterRegistryLive,
  makeProviderAdapterRegistryLive,
} from "./ProviderAdapterRegistry.ts";
import { ProviderUnsupportedError } from "../Errors.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const inspectActiveTurn = vi.fn();

const fakeCodexAdapter: CodexAdapterShape = {
  provider: "codex",
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  inspectActiveTurn,
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeClaudeAdapter: ClaudeAdapterShape = {
  provider: "claudeAgent",
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  inspectActiveTurn,
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeCliProxyAdapter: CliProxyAdapterShape = {
  ...fakeClaudeAdapter,
  provider: "cliProxy",
};

const fakeCopilotAdapter: CopilotAdapterShape = {
  provider: "copilot",
  capabilities: { sessionModelSwitch: "restart-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  inspectActiveTurn,
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeOpencodeAdapter: OpencodeAdapterShape = {
  provider: "opencode",
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  inspectActiveTurn,
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeKilocodeAdapter: KilocodeAdapterShape = {
  provider: "kilocode",
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  inspectActiveTurn,
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakePiAdapter: PiAdapterShape = {
  provider: "pi",
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  inspectActiveTurn,
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeCursorAdapter: CursorAdapterShape = {
  provider: "cursor",
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  inspectActiveTurn,
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeDevinAdapter: DevinAdapterShape = {
  provider: "devin",
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  inspectActiveTurn,
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const layer = it.layer(
  Layer.mergeAll(
    Layer.provide(
      makeProviderAdapterRegistryLive({
        optionalRegistrations: [{ provider: "cliProxy", service: fakeCliProxyAdapter }],
      }),
      Layer.mergeAll(
        Layer.succeed(CodexAdapter, fakeCodexAdapter),
        Layer.succeed(ClaudeAdapter, fakeClaudeAdapter),
        Layer.succeed(CopilotAdapter, fakeCopilotAdapter),
        Layer.succeed(OpencodeAdapter, fakeOpencodeAdapter),
        Layer.succeed(PiAdapter, fakePiAdapter),
        Layer.succeed(CursorAdapter, fakeCursorAdapter),
        Layer.succeed(DevinAdapter, fakeDevinAdapter),
        Layer.succeed(KilocodeAdapter, fakeKilocodeAdapter),
      ),
    ),
    NodeServices.layer,
  ),
);

layer("ProviderAdapterRegistryLive", (it) => {
  it.effect("resolves a registered provider adapter", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry;
      const codex = yield* registry.getByProvider("codex");
      const claude = yield* registry.getByProvider("claudeAgent");
      const cliProxy = yield* registry.getByProvider("cliProxy");
      const copilot = yield* registry.getByProvider("copilot");
      const opencode = yield* registry.getByProvider("opencode");
      const kilocode = yield* registry.getByProvider("kilocode");
      const pi = yield* registry.getByProvider("pi");
      assert.equal(codex, fakeCodexAdapter);
      assert.equal(claude, fakeClaudeAdapter);
      assert.equal(cliProxy, fakeCliProxyAdapter);
      assert.equal(copilot, fakeCopilotAdapter);
      assert.equal(opencode, fakeOpencodeAdapter);
      assert.equal(kilocode, fakeKilocodeAdapter);
      assert.equal(pi, fakePiAdapter);

      const providers = yield* registry.listProviders();
      assert.deepEqual(providers, [
        "codex",
        "claudeAgent",
        "cliProxy",
        "copilot",
        "cursor",
        "devin",
        "kilocode",
        "opencode",
        "pi",
      ]);
    }),
  );

  it.effect("fails with ProviderUnsupportedError for unknown providers", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry;
      const adapter = yield* registry.getByProvider("unknown" as ProviderKind).pipe(Effect.result);
      assertFailure(adapter, new ProviderUnsupportedError({ provider: "unknown" }));
    }),
  );
});

const withoutCliProxyLayer = it.layer(
  Layer.mergeAll(
    Layer.provide(
      ProviderAdapterRegistryLive,
      Layer.mergeAll(
        Layer.succeed(CodexAdapter, fakeCodexAdapter),
        Layer.succeed(ClaudeAdapter, fakeClaudeAdapter),
        Layer.succeed(CopilotAdapter, fakeCopilotAdapter),
        Layer.succeed(OpencodeAdapter, fakeOpencodeAdapter),
        Layer.succeed(PiAdapter, fakePiAdapter),
        Layer.succeed(CursorAdapter, fakeCursorAdapter),
        Layer.succeed(DevinAdapter, fakeDevinAdapter),
        Layer.succeed(KilocodeAdapter, fakeKilocodeAdapter),
      ),
    ),
    NodeServices.layer,
  ),
);

withoutCliProxyLayer("ProviderAdapterRegistryLive without CLIProxy", (it) => {
  it.effect("omits the adapter when its optional service is absent", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry;
      const providers = yield* registry.listProviders();
      const adapter = yield* registry.getByProvider("cliProxy").pipe(Effect.result);

      assert.deepEqual(providers, [
        "codex",
        "claudeAgent",
        "copilot",
        "cursor",
        "devin",
        "kilocode",
        "opencode",
        "pi",
      ]);
      assertFailure(adapter, new ProviderUnsupportedError({ provider: "cliProxy" }));
    }),
  );
});
