import { join } from "node:path";
import { Effect, Layer } from "effect";
import type { RemoteRuntimeUpdateAffectedWork } from "@bigbud/contracts/server/remoteBackendUpdate.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { RemoteRuntimeUpdateOperationsLive } from "../persistence/Layers/RemoteRuntimeUpdateOperations.ts";
import { makeRemoteRuntimeUpdateLive } from "./Layers/RemoteRuntimeUpdate.ts";
import { readRuntimeArchivePointer } from "./runtimeArchive.pointer.ts";
import type { RuntimeArchiveStore } from "./runtimeArchive.store.ts";
import {
  makeRuntimeArchiveFixture,
  signedManifest,
  verifyGraphAt,
  writeGraph,
} from "./runtimeArchive.test.helpers.ts";
import type {
  RemoteRuntimeUpdateDependencies,
  RuntimeUpdateGraphSource,
} from "./Services/RemoteRuntimeUpdate.ts";

export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export interface RuntimeUpdateHarness {
  /** Private temp directory; the SQLite file for restart tests lives here. */
  readonly dbPath: string;
  readonly deps: RemoteRuntimeUpdateDependencies;
  /** Every store the operation opened, with the checkpoint it received. */
  readonly stores: Array<RuntimeArchiveStore>;
  readonly work: Array<RemoteRuntimeUpdateAffectedWork>;
  readonly resolves: Array<string>;
  /** Gate extraction: resolves when the test calls `release()`. */
  gate: { promise: Promise<void>; release: () => void } | undefined;
  failExtract: boolean;
  readonly pointer: () => Promise<Awaited<ReturnType<typeof readRuntimeArchivePointer>>>;
  readonly checkpointOutsideLockRejects: () => Promise<boolean>;
}

export function makeGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export async function makeRuntimeUpdateHarness(
  cleanup: Array<string>,
): Promise<RuntimeUpdateHarness> {
  const fixture = await makeRuntimeArchiveFixture(cleanup);
  const harness: RuntimeUpdateHarness = {
    dbPath: join(fixture.parent, "state.sqlite"),
    stores: [],
    work: [],
    resolves: [],
    gate: undefined,
    failExtract: false,
    // Reads through a store the operation opened, so polling never races its first open.
    pointer: async () => readRuntimeArchivePointer(harness.stores[0] ?? (await fixture.open())),
    checkpointOutsideLockRejects: async () => {
      const store = harness.stores.at(-1);
      if (!store) return false;
      return store.checkpoint().then(
        () => false,
        () => true,
      );
    },
    deps: undefined as never,
  };
  const graphSource: RuntimeUpdateGraphSource = {
    resolve: async ({ version }) => {
      harness.resolves.push(version);
      return {
        manifest: signedManifest(version),
        extract: async (graphRoot, signal) => {
          await harness.gate?.promise;
          signal.throwIfAborted();
          if (harness.failExtract) throw new Error("Simulated extraction failure.");
          await writeGraph(graphRoot, version);
          return verifyGraphAt(graphRoot, version);
        },
      };
    },
  };
  (harness as { deps: RemoteRuntimeUpdateDependencies }).deps = {
    openStore: async (checkpoint) => {
      const store = await fixture.open(checkpoint);
      harness.stores.push(store);
      return store;
    },
    graphSource,
    affectedWork: () => Effect.sync(() => [...harness.work]),
  };
  return harness;
}

/** A persistent SQLite file so a second layer build models a backend restart. */
export function runtimeUpdateLayer(deps: RemoteRuntimeUpdateDependencies, dbPath: string) {
  const sql = NodeSqliteClient.layer({ filename: dbPath });
  const repository = RemoteRuntimeUpdateOperationsLive.pipe(
    Layer.provideMerge(Layer.effectDiscard(runMigrations()).pipe(Layer.provideMerge(sql))),
  );
  return makeRemoteRuntimeUpdateLive(deps).pipe(Layer.provideMerge(repository));
}
