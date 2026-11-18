import type { PeerDispatch, PeerResultSummary } from "@bigbud/contracts/server/remotePeer.ts";
import type { PeerChildStatus } from "@bigbud/contracts/server/remotePeer.wire.ts";
import type { PeerSetupErrorCode } from "@bigbud/contracts/server/remotePeer.pairing.ts";
import { Effect, Layer } from "effect";

import {
  WORKER_AUTHORITY,
  COORDINATOR_AUTHORITY,
} from "../peer-orchestration/peerFixtures.test.helpers.ts";
import { PeerDispatchRepositoryLive } from "../persistence/Layers/PeerDispatches.ts";
import { PeerDispatchRequestRepositoryLive } from "../persistence/Layers/PeerDispatchRequests.ts";
import { PeerPairingRepositoryLive } from "../persistence/Layers/PeerPairings.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { PeerDispatchRepository } from "../persistence/Services/PeerDispatches.ts";
import { PeerDispatchRequestRepository } from "../persistence/Services/PeerDispatchRequests.ts";
import { PeerPairingRepository } from "../persistence/Services/PeerPairings.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import type { PeerCoordinatorDeps } from "./peerDispatch.deps.ts";
import type { PeerResultDelivery } from "./peerDispatch.delivery.ts";
import { classifyPeerReply, type PeerTransport } from "./peerDispatch.transport.ts";

export const GRANT_ID = "00000001-0000-4000-8000-000000000001";
export const CALLER_THREAD = "thread-coordinator";
export const PIN = `ssh-ed25519 ${Buffer.concat([
  Buffer.from([0, 0, 0, 11]),
  Buffer.from("ssh-ed25519"),
  Buffer.from([0, 0, 0, 32]),
  Buffer.alloc(32, 7),
]).toString("base64")}`;

export const peerTestLayer = Layer.mergeAll(
  PeerDispatchRepositoryLive,
  PeerDispatchRequestRepositoryLive,
  PeerPairingRepositoryLive,
).pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));

interface FakeChild {
  readonly dispatchId: string;
  readonly childThreadId: string;
  state: PeerChildStatus["state"];
  cancelRequested: boolean;
  result: PeerResultSummary | null;
}

/**
 * A worker that behaves like WP-8B: one child per dispatch identity, `dispatch-unknown` for
 * identities it never recorded, idempotent cancel. Faults: `partition` (request never arrives),
 * `dropReplies` (request is processed, reply is lost), `setup` (ssh refuses before the helper).
 */
export class FakeWorker {
  readonly children = new Map<string, FakeChild>();
  readonly calls: Array<{ action: string; body: Record<string, unknown> }> = [];
  launches = 0;
  partition = false;
  dropReplies: Partial<Record<string, number>> = {};
  setup: PeerSetupErrorCode | null = null;
  /** Interrupting a running child cancels it (an idle, unstarted child stays running). */
  cancelInterrupts = true;

  finish(dispatchId: string, outcome: PeerResultSummary["outcome"], summary: string) {
    const child = this.children.get(dispatchId)!;
    child.state = outcome;
    child.result = { outcome, summary, truncated: false, attachments: [] };
  }

  private status(child: FakeChild): PeerChildStatus {
    return {
      dispatchId: child.dispatchId,
      commandId: `peer:${COORDINATOR_AUTHORITY}:${child.dispatchId}`,
      childThreadId: child.childThreadId,
      state: child.state,
      workflowStatus: child.state,
      cancelRequested: child.cancelRequested,
      result: child.result,
    } as PeerChildStatus;
  }

  private handle(action: string, body: Record<string, unknown>): [number, unknown] {
    const dispatchId = String(body.dispatchId);
    const unknown = [404, { error: { code: "dispatch-unknown", message: "unknown" } }] as [
      number,
      unknown,
    ];
    let child = this.children.get(dispatchId);
    if (action === "delegate") {
      const replayed = child !== undefined;
      if (!child) {
        this.launches++;
        child = {
          dispatchId,
          childThreadId: `peer-thread:${dispatchId}`,
          state: "running",
          cancelRequested: false,
          result: null,
        };
        this.children.set(dispatchId, child);
      }
      return [200, { ...this.status(child), replayed }];
    }
    if (!child) return unknown;
    if (action === "cancel") {
      child.cancelRequested = true;
      if (child.state === "running" && this.cancelInterrupts)
        this.finish(dispatchId, "cancelled", "The child was cancelled.");
    }
    return [200, this.status(child)];
  }

  readonly transport: PeerTransport = {
    request: async ({ action, body }) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (this.setup) return { _tag: "setup", code: this.setup, message: this.setup };
      if (this.partition) return { _tag: "unreachable", message: "partitioned" };
      const record = body as Record<string, unknown>;
      this.calls.push({ action, body: record });
      const [status, reply] = this.handle(action, record);
      const drop = this.dropReplies[action] ?? 0;
      if (drop > 0) {
        this.dropReplies[action] = drop - 1;
        return { _tag: "unreachable", message: "reply lost" };
      }
      return classifyPeerReply(status, reply);
    },
  };

  count(action: string) {
    return this.calls.filter((call) => call.action === action).length;
  }
}

/** Receipt-faithful delivery double: one turn per command id, however often it is called. */
export class FakeThread {
  readonly calls: PeerResultDelivery[] = [];
  readonly turns: PeerResultDelivery[] = [];
  failNext = 0;
  hang = false;
  deliver = (delivery: PeerResultDelivery) =>
    Effect.suspend(() => {
      this.calls.push(delivery);
      if (!this.turns.some((turn) => turn.commandId === delivery.commandId))
        this.turns.push(delivery);
      if (this.hang) return Effect.never;
      if (this.failNext > 0) {
        this.failNext--;
        return Effect.fail(new Error("thread busy"));
      }
      return Effect.void;
    });
}

let ids = 0;
export const makePeerTestDeps = Effect.fn("makePeerTestDeps")(function* (
  worker: FakeWorker,
  thread: FakeThread,
  overrides: Partial<PeerCoordinatorDeps> = {},
) {
  return {
    coordinatorAuthorityId: COORDINATOR_AUTHORITY,
    dispatches: yield* PeerDispatchRepository,
    requests: yield* PeerDispatchRequestRepository,
    pairings: yield* PeerPairingRepository,
    transport: worker.transport,
    deliver: thread.deliver,
    callerRuntimeMode: () => Effect.succeed("full-access" as const),
    setupErrors: new Map(),
    now: () => new Date().toISOString(),
    newDispatchId: () => `00000002-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    retryDelayMs: () => 5,
    followWaitMs: 0,
    ...overrides,
  } satisfies PeerCoordinatorDeps;
});

/** Migrates and stores one saved connection; with `grant` it also records an active grant. */
export const seedPairing = Effect.fn("seedPairing")(function* (grant = true) {
  yield* runMigrations();
  const pairings = yield* PeerPairingRepository;
  const at = new Date().toISOString();
  const pairing = yield* pairings.save({
    connection: {
      pairingId: "00000003-0000-4000-8000-000000000001",
      label: "worker-one",
      workerAuthorityId: WORKER_AUTHORITY,
      host: "w1.example.test",
      port: 22,
      user: "bigbud",
      pinnedHostKey: PIN,
      hostKeyFingerprint: "SHA256:test",
      hostKeyConfirmedAt: at,
      workspaceRoot: "/srv/work",
      provider: "codex",
      runtimeMode: "auto-accept-edits",
      coordinatorKeyFingerprint: `sha256:${"b".repeat(64)}`,
    },
    at,
  });
  return grant ? (yield* pairings.recordGrant(pairing.pairingId, GRANT_ID, at))! : pairing;
});

/** Polls the row until `done` holds (real time; the fake worker answers in milliseconds). */
export const waitForDispatch = Effect.fn("waitForDispatch")(function* (
  dispatchId: string,
  done: (dispatch: PeerDispatch) => boolean,
  timeoutMs = 3_000,
) {
  const dispatches = yield* PeerDispatchRepository;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const dispatch = yield* dispatches.get(dispatchId);
    if (dispatch && done(dispatch)) return dispatch;
    if (Date.now() > deadline)
      throw new Error(`dispatch ${dispatchId} stuck in ${dispatch?.state ?? "missing"}`);
    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
  }
});
