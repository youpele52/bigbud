import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import {
  approveSshAliasDescriptor,
  checkSshAliasDescriptor,
} from "./SshAliasDescriptorBindings.ts";

const saved = new Uint8Array(32).fill(1);
const retargeted = new Uint8Array(32).fill(2);
const target = "ssh:host=workbench&auth=ssh-key&transport=direct-ssh";

it.effect("binds a saved alias descriptor per profile and never overwrites it implicitly", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 182 });
    yield* sql`INSERT INTO remote_execution_target_disconnects VALUES (${target}, 41)`;
    yield* runMigrations();
    // The additive migration leaves the disconnect store untouched.
    assert.deepEqual(yield* sql`SELECT * FROM remote_execution_target_disconnects`, [
      { target_id: target, disconnected_at: 41 },
    ]);
    assert.strictEqual(yield* checkSshAliasDescriptor(sql, "profile-a", target, saved), "unbound");
    assert.strictEqual(
      yield* approveSshAliasDescriptor(sql, "profile-a", target, saved, "firstUse"),
      "match",
    );
    // A later save with a different descriptor cannot replace the approved one.
    assert.strictEqual(
      yield* approveSshAliasDescriptor(sql, "profile-a", target, retargeted, "firstUse"),
      "changed",
    );
    assert.strictEqual(
      yield* checkSshAliasDescriptor(sql, "profile-a", target, retargeted),
      "changed",
    );
    // Another profile sharing the database has its own, independent binding.
    assert.strictEqual(
      yield* checkSshAliasDescriptor(sql, "profile-b", target, retargeted),
      "unbound",
    );
    assert.strictEqual(
      yield* approveSshAliasDescriptor(sql, "profile-b", target, retargeted, "firstUse"),
      "match",
    );
    assert.strictEqual(yield* checkSshAliasDescriptor(sql, "profile-a", target, saved), "match");
    assert.strictEqual(
      yield* approveSshAliasDescriptor(sql, "profile-a", target, retargeted, "reapprove"),
      "match",
    );
    assert.strictEqual(yield* checkSshAliasDescriptor(sql, "profile-a", target, saved), "changed");
    const malformed = yield* Effect.exit(
      checkSshAliasDescriptor(sql, "profile-a", target, new Uint8Array(31)),
    );
    assert.isTrue(Exit.isFailure(malformed));
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
