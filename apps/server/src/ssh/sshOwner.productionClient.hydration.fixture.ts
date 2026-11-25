import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { commitLegacyRetirement } from "../persistence/Layers/LegacyRetirement.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { runSshOwnerBootSequence, type SshOwnerProductionOwner } from "./sshOwnerProductionBoot.ts";
import { startOrAttachSshOwnerProduction } from "./sshOwnerProductionClient.ts";
import { resolveSshOwnerLaunchFacts } from "./sshOwnerProductionClient.launch.ts";
import {
  readSshOwnerHydrationSnapshot,
  type SshOwnerHydrationSnapshot,
} from "./sshOwnerProductionHydration.ts";
import type { ProductionFixture } from "./sshOwnerProductionClient.fixture.ts";
import { readSshOwnerStartupState } from "./sshOwnerStartupRefusal.ts";

/**
 * Shared boot-sequence fixture for the owner reconciliation tests. It seeds the
 * Build A marker so only the reconciliation decision can keep admission closed.
 *
 * @module sshOwner.productionClient.hydration.fixture
 */

export type Sql = SqlClient.SqlClient;

export const withPersistence = <A, E>(
  fixture: ProductionFixture,
  run: (sql: Sql) => Effect.Effect<A, E>,
): Promise<A> => {
  const layer = makeSqlitePersistenceLive(join(fixture.stateDirectory, "state.sqlite"), {
    worker: false,
  }).pipe(Layer.provide(NodeServices.layer));
  return Effect.runPromise(
    Effect.flatMap(Effect.service(SqlClient.SqlClient), run).pipe(Effect.provide(layer)),
  );
};

export const markBuildADrained = (sql: Sql, profileScope: string) =>
  Effect.runPromise(
    commitLegacyRetirement(sql, {
      profileScope,
      artifactId: "build-a",
      decision: "drain-now",
      drainedLeases: [],
      pendingItems: [],
    }),
  );

export function bootInput(input: {
  readonly fixture: ProductionFixture;
  readonly sql: Sql;
  readonly order: string[];
  readonly ownerPath: string;
  readonly snapshot?: () => Effect.Effect<SshOwnerHydrationSnapshot>;
}) {
  return {
    acquireStateLock: Effect.sync(() => {
      input.order.push("lock");
    }),
    readState: readSshOwnerStartupState(input.sql, {
      profileScope: input.fixture.stateDirectory,
      ownerPresent: Effect.succeed(true),
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          input.order.push("marker");
        }),
      ),
    ),
    startOrAttachOwner: startOrAttachSshOwnerProduction({
      artifact: input.fixture.artifact(input.ownerPath, "desktop-packaged"),
      facts: resolveSshOwnerLaunchFacts({
        ...input.fixture.profile,
        kind: "desktop-packaged",
      }),
      sql: input.sql,
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          input.order.push("owner");
        }),
      ),
    ),
    hydrate: (handle: SshOwnerProductionOwner) =>
      Effect.gen(function* () {
        input.order.push("hydrate");
        if (input.snapshot) return yield* Effect.flatMap(input.snapshot(), handle.hydrate);
        return yield* Effect.flatMap(
          readSshOwnerHydrationSnapshot(input.sql, input.fixture.stateDirectory),
          handle.hydrate,
        );
      }),
    openAdmission: () =>
      Effect.sync(() => {
        input.order.push("admission");
      }),
  };
}

export const runBoot = (input: {
  readonly fixture: ProductionFixture;
  readonly sql: Sql;
  readonly order: string[];
  readonly ownerPath: string;
}) => runSshOwnerBootSequence(bootInput(input));
