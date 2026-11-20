import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { PeerPairingRepository } from "../persistence/Services/PeerPairings.ts";
import { createCodexThreadOrchestrationDynamicTools } from "./codexThreadDynamicTools.specs.ts";
import { peerResultCommandId } from "./peerDispatch.delivery.ts";
import { makePeerDispatchService } from "./peerDispatch.service.ts";
import {
  CALLER_THREAD,
  FakeThread,
  FakeWorker,
  makePeerTestDeps,
  peerTestLayer,
  PIN,
  seedPairing,
  waitForDispatch,
} from "./peerDispatch.test.helpers.ts";
import { renderOrchestrationMcpServerSource } from "./orchestrationMcpBridge.template.ts";
import { renderPiRemoteAgentToolsSource } from "./PiOrchestrationBridge.template.remoteAgent.ts";
import { PEER_TOOL_NAMES, PEER_TOOLS_NOT_OFFERED, peerToolsOfferedTo } from "./peerTools.shared.ts";
import { runPeerTool } from "./ThreadPeerTools.ts";

const delegateInput = (invocationId: string, host?: string) => ({
  callerThreadId: CALLER_THREAD,
  invocationId,
  task: "Summarize the logs.",
  ...(host ? { host } : {}),
});

it.live("a refusal after acceptance delivers one failure result (F-P8-4, O-5)", () =>
  Effect.gen(function* () {
    const pairing = yield* seedPairing();
    const worker = new FakeWorker();
    const thread = new FakeThread();
    const deps = yield* makePeerTestDeps(worker, thread);
    const service = yield* makePeerDispatchService(deps, { toolWaitMs: 300 });
    const first = yield* service.delegate(delegateInput("refused-1"));
    const dispatchId = String(first.dispatchId);
    yield* waitForDispatch(dispatchId, (d) => d.state === "following");

    // The grant is re-issued and the worker no longer reports this child.
    const pairings = yield* PeerPairingRepository;
    yield* pairings.recordGrant(
      pairing.pairingId,
      "00000001-0000-4000-8000-000000000077",
      new Date().toISOString(),
    );
    worker.children.delete(dispatchId);
    const failed = yield* waitForDispatch(dispatchId, (d) => d.state === "failed");
    assert.strictEqual(failed.result?.outcome, "failed");
    assert.match(failed.result?.summary ?? "", /grant superseded/);
    assert.strictEqual(failed.error?.code, "dispatch-unknown");
    // Exactly one delivery, with the dispatch's delivery id.
    assert.deepStrictEqual(
      thread.turns.map((turn) => turn.commandId),
      [peerResultCommandId(dispatchId)],
    );
    assert.match(thread.turns[0]!.text, /failed/);
    yield* Effect.sleep("100 millis");
    assert.strictEqual(thread.turns.length, 1);
  }).pipe(Effect.scoped, Effect.provide(peerTestLayer)),
);

it.live("delegating to a named revoked host is unavailable while another is active (O-4)", () =>
  Effect.gen(function* () {
    const first = yield* seedPairing();
    const pairings = yield* PeerPairingRepository;
    const at = new Date().toISOString();
    const second = yield* pairings.save({
      connection: {
        pairingId: "00000003-0000-4000-8000-000000000002",
        label: "worker-two",
        workerAuthorityId: "f".repeat(32),
        host: "w2.example.test",
        port: 22,
        user: "bigbud",
        pinnedHostKey: PIN,
        hostKeyFingerprint: "SHA256:test2",
        hostKeyConfirmedAt: at,
        workspaceRoot: "/srv/work",
        provider: "codex",
        runtimeMode: "auto-accept-edits",
        coordinatorKeyFingerprint: `sha256:${"b".repeat(64)}`,
      },
      at,
    });
    yield* pairings.recordGrant(second.pairingId, "00000001-0000-4000-8000-000000000002", at);
    yield* pairings.revoke(first.pairingId, at);
    const worker = new FakeWorker();
    const deps = yield* makePeerTestDeps(worker, new FakeThread());
    const service = yield* makePeerDispatchService(deps, { toolWaitMs: 100 });
    const revoked = yield* service.delegate(delegateInput("o4-1", "worker-one"));
    assert.isTrue(revoked.unavailable);
    assert.deepInclude(revoked.error as object, { code: "grant-revoked" });
    assert.strictEqual(worker.calls.length, 0);
    // An unknown name stays a plain refusal; the active host still works.
    const unknown = yield* service.delegate(delegateInput("o4-2", "nowhere"));
    assert.isUndefined(unknown.unavailable);
    const active = yield* service.delegate(delegateInput("o4-3", "worker-two"));
    assert.isString(active.dispatchId);
  }).pipe(Effect.scoped, Effect.provide(peerTestLayer)),
);

it.effect("background sessions are not offered the peer tools (O-2)", () =>
  Effect.gen(function* () {
    const background = "learning-00000000-0000-4000-8000-000000000001-x";
    assert.isFalse(peerToolsOfferedTo(background));
    assert.isFalse(peerToolsOfferedTo(`learning-v2-${"a".repeat(64)}`));
    assert.isTrue(peerToolsOfferedTo(CALLER_THREAD));
    // The dispatcher refuses them even if a surface listed them.
    const refused = yield* runPeerTool({} as never, {
      callerThreadId: background,
      invocationId: "bg-1",
      tool: "delegate_to_host",
      arguments: { task: "x" },
    });
    assert.deepStrictEqual(refused, PEER_TOOLS_NOT_OFFERED);
    // Every listing surface leaves them out for a background thread only.
    const names = (peerTools: boolean) =>
      createCodexThreadOrchestrationDynamicTools({ peerTools }).map((tool) => tool.name);
    for (const name of PEER_TOOL_NAMES) {
      assert.include(names(true), name);
      assert.notInclude(names(false), name);
    }
    const mcp = (threadId: string) =>
      renderOrchestrationMcpServerSource({ host: "127.0.0.1", port: 1, threadId, token: "t" });
    assert.include(
      mcp(background),
      `const HIDDEN_TOOLS = new Set(${JSON.stringify(PEER_TOOL_NAMES)})`,
    );
    assert.include(mcp(CALLER_THREAD), "const HIDDEN_TOOLS = new Set([])");
    assert.notInclude(renderPiRemoteAgentToolsSource({ peerTools: false }), "delegate_to_host");
    assert.include(renderPiRemoteAgentToolsSource({ peerTools: true }), "delegate_to_host");
  }),
);
