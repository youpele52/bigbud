import { fileURLToPath } from "node:url";

import * as Layer from "effect/Layer";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeWorkerConnection } from "./NodeSqliteClient.worker.ts";
import { exitProcessOnSqliteWorkerFailure } from "./NodeSqliteClient.worker.exit.ts";
import { makeSqliteClient } from "./SqliteClient.connection.ts";

/** Bun development usage reads share the existing bridge, but never import node:sqlite. */
export const layer = (config: { readonly filename: string }) =>
  Layer.effect(
    SqlClient.SqlClient,
    makeSqliteClient(
      {},
      makeWorkerConnection(
        fileURLToPath(new URL("./BunSqliteReadWorker.ts", import.meta.url)),
        {
          filename: config.filename,
          readonly: true,
          allowExtension: false,
          prepareCacheSize: 200,
        },
        undefined,
        { onUnexpectedFailure: exitProcessOnSqliteWorkerFailure },
      ),
    ),
  ).pipe(Layer.provide(Reactivity.layer));
