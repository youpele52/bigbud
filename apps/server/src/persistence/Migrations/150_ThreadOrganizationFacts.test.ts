import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ServerConfig } from "../../startup/config.ts";

const layer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "bigbud-organization-install-" }),
  NodeSqliteClient.layerMemory(),
).pipe(Layer.provideMerge(NodeServices.layer));
it.effect("new empty database/profile records new installation before applying any schema", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    assert.deepEqual(yield* sql`SELECT classification FROM thread_organization_installation`, [
      { classification: "new" },
    ]);
    yield* runMigrations();
    assert.deepEqual(yield* sql`SELECT classification FROM thread_organization_installation`, [
      { classification: "new" },
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("existing settings or earlier database history stays opt-in even with no threads", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig;
    yield* fs.writeFileString(config.settingsPath, "{}");
    yield* runMigrations({ toMigrationInclusive: 149 });
    yield* fs.remove(config.settingsPath);
    yield* runMigrations();
    assert.deepEqual(yield* sql`SELECT classification FROM thread_organization_installation`, [
      { classification: "existing" },
    ]);
    assert.deepEqual(yield* sql`SELECT * FROM thread_organization_runtime_threads`, []);
  }).pipe(Effect.provide(layer)),
);
