import { randomUUID } from "node:crypto";
import type { ServerSettings } from "@bigbud/contracts/core/settings.ts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { withMetadataTransaction } from "../../persistence/Layers/ThreadMetadataGeneration.transaction.ts";
import type { ServerSettingsShape } from "../../ws/serverSettings.ts";
import type { SettingsSnapshot } from "../../ws/serverSettings.snapshot.ts";
import { metadataFingerprint } from "./ThreadMetadataGeneration.policy.ts";

/** Discovery-only model lists do not alter the provider's execution configuration. */
export const metadataProviderConfiguration = (configuration: object) =>
  Object.fromEntries(Object.entries(configuration).filter(([key]) => key !== "customModels"));

/** Discovery lists and unrelated UI/provider settings must not replenish an attempt budget. */
export function metadataConfigurationFingerprint(settings: ServerSettings): string {
  const selection = settings.textGenerationModelSelection;
  const provider = selection && settings.providers[selection.provider];
  const configuration = provider ? metadataProviderConfiguration(provider) : null;
  return metadataFingerprint({ selection, configuration });
}

type Observation = { fingerprint: string; epoch: string | null };
const authorities = new WeakMap<
  ServerSettingsShape,
  {
    readonly permit: Semaphore.Semaphore;
    readonly observe: (snapshot: SettingsSnapshot) => void;
    readonly read: () => Observation | undefined;
  }
>();

function authorityFor(settings: ServerSettingsShape) {
  const existing = authorities.get(settings);
  if (existing) return existing;
  let observed: Observation | undefined;
  const observe = (snapshot: SettingsSnapshot) => {
    const fingerprint = metadataConfigurationFingerprint(snapshot.settings);
    if (!observed) observed = { fingerprint, epoch: null };
    else if (observed.fingerprint !== fingerprint) observed = { fingerprint, epoch: randomUUID() };
  };
  const authority = { permit: Semaphore.makeUnsafe(1), observe, read: () => observed };
  authorities.set(settings, authority);
  // The subscription has the settings object's lifetime, shared by all consumers. In
  // particular, commit hooks must observe changes before capture/service startup.
  settings.onSnapshotChange?.(observe);
  const initial = settings.currentSnapshot?.();
  if (initial) observe(initial);
  return authority;
}

/** Every relevant accepted change invalidates authority synchronously, including A -> B -> A.
 * Persistence happens under the settings barrier before capturing or dispatching a job.
 * On restart an unchanged setting retains the durable epoch and its warning/budget identity.
 * This configuration fence never proves provider/account identity.
 */
export const makeMetadataConfiguration = Effect.fn("makeMetadataConfiguration")(function* (
  settings: ServerSettingsShape,
) {
  const sql = yield* SqlClient.SqlClient;
  const authority = authorityFor(settings);
  const mapError = Effect.mapError(toPersistenceSqlError("ThreadMetadataGeneration.configuration"));
  // Call only within withSnapshotBarrier, before opening a metadata SQL transaction.
  const epochFor = (snapshot: SettingsSnapshot) =>
    authority.permit.withPermits(1)(
      withMetadataTransaction(
        sql,
        Effect.gen(function* () {
          authority.observe(snapshot);
          const current = authority.read()!;
          const rows = yield* sql<{ fingerprint: string; epoch: string }>`
            SELECT fingerprint, epoch FROM thread_metadata_configuration_epoch WHERE singleton = 1`;
          const retained = rows[0];
          const epoch =
            current.epoch ??
            (retained?.fingerprint === current.fingerprint ? retained.epoch : randomUUID());
          if (retained?.epoch !== epoch || retained.fingerprint !== current.fingerprint)
            yield* sql`INSERT INTO thread_metadata_configuration_epoch (singleton, fingerprint, epoch)
              VALUES (1, ${current.fingerprint}, ${epoch}) ON CONFLICT(singleton)
              DO UPDATE SET fingerprint = excluded.fingerprint, epoch = excluded.epoch`;
          current.epoch = epoch;
          return epoch;
        }),
      ).pipe(mapError),
    );
  // Safe inside the canonical SQL transaction: never acquire settings/history or the
  // epoch persistence permit here (their lock order is settings -> history -> SQL).
  const isCurrent = (epoch: string) =>
    Effect.gen(function* () {
      if (!settings.currentSnapshot || !settings.onSnapshotChange) return false;
      const rows = yield* sql<{ fingerprint: string; epoch: string }>`
      SELECT fingerprint, epoch FROM thread_metadata_configuration_epoch WHERE singleton = 1`;
      const current = authority.read();
      const snapshot = settings.currentSnapshot();
      return (
        !!current &&
        !!snapshot &&
        rows[0]?.epoch === epoch &&
        rows[0].fingerprint === current.fingerprint &&
        metadataConfigurationFingerprint(snapshot.settings) === current.fingerprint &&
        (current.epoch === null || current.epoch === epoch)
      );
    }).pipe(mapError);
  return { epochFor, isCurrent };
});
