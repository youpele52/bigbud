/**
 * Activation harness: each "process" is a fresh layer (own gate, own scope) over one shared
 * SQLite file, state directory and archive store, so tests model the old runtime, the restarted
 * runtime on trial and the rolled-back runtime as separate starts.
 */
import { dirname, join } from "node:path";
import { Deferred, Effect, Layer, ManagedRuntime } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  makeRuntimeMaintenanceGate,
  type RuntimeMaintenanceGateShape,
} from "../command-admission/RuntimeMaintenanceGate.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { RemoteRuntimeUpdateOperationsLive } from "../persistence/Layers/RemoteRuntimeUpdateOperations.ts";
import { makeRemoteRuntimeUpdateLive } from "./Layers/RemoteRuntimeUpdate.ts";
import { runtimeArchiveKeyForManifest } from "./runtimeArchive.key.ts";
import { signedManifest } from "./runtimeArchive.test.helpers.ts";
import type {
  RuntimeUpdateActivationContext,
  RuntimeUpdateStepError,
} from "./runtimeUpdate.activate.context.ts";
import {
  makeRuntimeUpdateActivation,
  sweepRuntimeUpdateJournal,
} from "./runtimeUpdate.activate.resume.ts";
import { recoverRuntimeUpdateRestore } from "./runtimeUpdate.backup.ts";
import type { RuntimeUpdateDrainProbe } from "./runtimeUpdate.drain.ts";
import { recordStagedGraphPins } from "./runtimeUpdate.graphSource.ts";
import { hasRuntimeUpdateJournal } from "./runtimeUpdate.journal.ts";
import {
  makeRuntimeUpdateHarness,
  type RuntimeUpdateHarness,
} from "./runtimeUpdate.test.helpers.ts";
import type { RuntimeUpdateServiceUnit } from "./runtimeUpdate.unit.ts";
import {
  RemoteRuntimeUpdate,
  type RemoteRuntimeUpdateShape,
} from "./Services/RemoteRuntimeUpdate.ts";

export interface CountingGate extends RuntimeMaintenanceGateShape {
  /** How often admission was closed: a refusal before any outage never closes it. */
  closes: number;
}

export function countingGate(initiallyClosed: boolean): CountingGate {
  const base = makeRuntimeMaintenanceGate({ initiallyClosed });
  const counted: CountingGate = {
    ...base,
    closes: 0,
    close: Effect.suspend(() => {
      counted.closes += 1;
      return base.close;
    }),
  };
  return counted;
}

export interface FakeUnit extends RuntimeUpdateServiceUnit {
  readonly calls: Array<string>;
  config: string;
  receipt: string;
  onRestart: () => Promise<void>;
}

export function makeFakeUnit(): FakeUnit {
  const unit: FakeUnit = {
    calls: [],
    config: "config:previous",
    receipt: "receipt:previous",
    onRestart: async () => {},
    assertManaged: async () => {},
    read: async () => ({ config: unit.config, receipt: unit.receipt }),
    pointAt: async (receipt, pins) => {
      unit.calls.push("pointAt");
      unit.config = `config:${pins.entryPath}`;
      unit.receipt = receipt;
    },
    restore: async (config, receipt) => {
      unit.calls.push("restore");
      unit.config = config;
      unit.receipt = receipt;
    },
    restart: async () => {
      unit.calls.push("restart");
      await unit.onRestart();
    },
  };
  return unit;
}

export interface ActivationHarness {
  readonly base: RuntimeUpdateHarness;
  readonly stateDir: string;
  readonly dbPath: string;
  readonly unit: FakeUnit;
  availableBytes: number;
}

export async function makeActivationHarness(cleanup: Array<string>): Promise<ActivationHarness> {
  const base = await makeRuntimeUpdateHarness(cleanup);
  const resolve = base.deps.graphSource.resolve;
  // Stage exactly as production does: pins and receipt are recorded beside the verified slot.
  (base.deps as { graphSource: typeof base.deps.graphSource }).graphSource = {
    resolve: async (input, signal) => {
      const graph = await resolve(input, signal);
      return {
        ...graph,
        extract: async (graphRoot, inner) => {
          const token = await graph.extract(graphRoot, inner);
          await recordStagedGraphPins(graphRoot, token, inner);
          return token;
        },
      };
    },
  };
  return {
    base,
    stateDir: dirname(base.dbPath),
    dbPath: base.dbPath,
    unit: makeFakeUnit(),
    availableBytes: 64 * 1024 ** 3,
  };
}

export const stagedEntryPath = (h: ActivationHarness, version: string) =>
  join(
    h.base.stores[0]!.entries,
    runtimeArchiveKeyForManifest(signedManifest(version)),
    "graph",
    "entry.mjs",
  );

export interface ProcessOptions {
  readonly runningEntry: () => string;
  readonly runningVersion?: string;
  readonly trial?: Effect.Effect<void, RuntimeUpdateStepError>;
}

export interface BackendProcess {
  readonly gate: CountingGate;
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, RemoteRuntimeUpdate | SqlClient.SqlClient>,
  ) => Promise<A>;
  readonly dispose: () => Promise<void>;
}

/** One backend start: pre-open restore, a gate from the journal, then the update service. */
export async function startBackendProcess(
  h: ActivationHarness,
  options: ProcessOptions,
): Promise<BackendProcess> {
  await recoverRuntimeUpdateRestore(h.stateDir, h.dbPath);
  const gate = countingGate(hasRuntimeUpdateJournal(h.stateDir));
  const probe: RuntimeUpdateDrainProbe = {
    affectedWork: Effect.sync(() => [...h.base.work]),
    settleCommands: Effect.void,
    interruptThread: () => Effect.void,
  };
  const sql = NodeSqliteClient.layer({ filename: h.dbPath });
  const repository = RemoteRuntimeUpdateOperationsLive.pipe(
    Layer.provideMerge(Layer.effectDiscard(runMigrations()).pipe(Layer.provideMerge(sql))),
  );
  const service = Layer.unwrap(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const ready = yield* Deferred.make<RemoteRuntimeUpdateShape>();
      const ctx: RuntimeUpdateActivationContext = {
        stateDir: h.stateDir,
        dbPath: h.dbPath,
        sql: yield* SqlClient.SqlClient,
        gate,
        probe,
        unit: h.unit,
        service: Deferred.await(ready),
        trialReadiness: options.trial ?? Effect.void,
        runningEntryPath: options.runningEntry,
        runningVersion: options.runningVersion ?? "1.0.0",
        diskProbe: { fileSize: async () => 1024, availableBytes: async () => h.availableBytes },
        deferRetryMs: 20,
        drain: { pollMs: 5, settleTimeoutMs: 200, inFlightTimeoutMs: 200 },
      };
      const publish = Layer.effectDiscard(
        Effect.gen(function* () {
          yield* Deferred.succeed(ready, yield* RemoteRuntimeUpdate);
          yield* sweepRuntimeUpdateJournal(ctx).pipe(Effect.ignore, Effect.forkIn(scope));
        }),
      );
      return publish.pipe(
        Layer.provideMerge(
          makeRemoteRuntimeUpdateLive({
            ...h.base.deps,
            activation: makeRuntimeUpdateActivation(ctx, scope),
          }),
        ),
      );
    }),
  ).pipe(Layer.provideMerge(repository));
  const runtime = ManagedRuntime.make(service);
  await runtime.runPromise(Effect.void);
  return {
    gate,
    run: (effect) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

export async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the update to settle.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export const operationState = (process: BackendProcess) =>
  process.run(
    Effect.gen(function* () {
      return (yield* (yield* RemoteRuntimeUpdate).status({})).operation;
    }),
  );
