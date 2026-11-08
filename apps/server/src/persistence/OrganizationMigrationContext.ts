import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as ServiceMap from "effect/ServiceMap";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../startup/config.ts";

/** Classified before any migration runs. An empty settings file alone is never new-install proof.
 * Verification workspaces/custom migration loaders without this context default to existing.
 */
export class OrganizationMigrationContext extends ServiceMap.Service<
  OrganizationMigrationContext,
  {
    readonly newInstallation: boolean;
  }
>()("bigbud/persistence/OrganizationMigrationContext") {}

export const classifyOrganizationInstallation = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table'
    AND name NOT LIKE 'sqlite_%' AND name <> 'effect_sql_migrations' LIMIT 1`;
  if (tables.length > 0) return false;
  const config = yield* Effect.serviceOption(ServerConfig);
  const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
  if (Option.isNone(config) || Option.isNone(fs)) return false;
  return yield* fs.value.exists(config.value.settingsPath).pipe(
    Effect.map((exists) => !exists),
    Effect.catchCause(() => Effect.succeed(false)),
  );
});
