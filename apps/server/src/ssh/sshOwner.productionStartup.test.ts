import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, beforeEach, vi } from "vitest";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { readLegacyRetirement } from "../persistence/Layers/LegacyRetirement.ts";
import {
  readSshOwnerAdmission,
  resetSshOwnerProductionStateForTest,
} from "./sshOwnerProductionComposition.ts";
import { bootActivatedStartup, retireProfile } from "./sshOwner.productionStartup.fixture.ts";
import {
  drainSshOwnerIdentifiedPanes,
  readSshOwnerStartupGate,
  SSH_OWNER_EXPLICIT_DRAIN_ARTIFACT_ID,
} from "./sshOwnerProductionStartup.ts";

// SSH always runs through the owner; the explicit drain request is an env flag.

const flags = vi.hoisted(() => ({ starts: 0 }));

vi.mock("./sshOwnerProductionClient.ts", async (importOriginal) => {
  const { Effect: E } = await import("effect");
  return {
    ...(await importOriginal<typeof import("./sshOwnerProductionClient.ts")>()),
    startProductionOwnerForBoot: () =>
      E.sync(() => {
        flags.starts += 1;
        return {
          profile: "remote-backend",
          artifactPath: "/fake/owner",
          hydrate: () => E.void,
          onDeath: () => () => {},
          shutdown: () => E.void,
        };
      }),
  };
});

vi.mock("./sshOwnerProductionHydration.ts", async (importOriginal) => {
  const { Effect: E } = await import("effect");
  return {
    ...(await importOriginal<typeof import("./sshOwnerProductionHydration.ts")>()),
    readSshOwnerHydrationSnapshot: () => E.succeed({}),
  };
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "ssh-owner-startup-"));
  resetSshOwnerProductionStateForTest();
  vi.stubEnv("BIGBUD_SSH_OWNER_DRAIN_IDENTIFIED", "0");
  flags.starts = 0;
});
afterEach(async () => {
  resetSshOwnerProductionStateForTest();
  await rm(root, { recursive: true, force: true });
});

const boot = (options: { readonly ownerPresent: boolean }) => bootActivatedStartup(root, options);
const retire = (sql: SqlClient.SqlClient, pendingItems: ReadonlyArray<string> = []) =>
  retireProfile(sql, root, pendingItems);

it.layer(NodeSqliteClient.layerMemory())("activated production startup", (it) => {
  it.effect("fences a never-drained machine, then opens after the explicit drain", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* boot({ ownerPresent: true });
        assert.deepInclude(readSshOwnerAdmission(), { kind: "closed", step: "retirement-marker" });
        const fenced = readSshOwnerAdmission();
        assert.equal(fenced.kind === "closed" && fenced.error.code, "legacyEntryFenced");
        assert.equal(
          fenced.kind === "closed" && "reason" in fenced.error && fenced.error.reason,
          "retirement-marker-missing",
        );
        assert.equal(flags.starts, 0);
        assert.equal(readSshOwnerStartupGate()?.state.kind, "refused");

        yield* drainSshOwnerIdentifiedPanes();
        assert.equal(readSshOwnerAdmission().kind, "open");
        assert.equal(flags.starts, 1);
        const record = yield* readLegacyRetirement(sql, root);
        assert.equal(record?.marker.artifactId, SSH_OWNER_EXPLICIT_DRAIN_ARTIFACT_ID);
        // A second drain is refused: nothing is fenced any more.
        const again = yield* Effect.flip(drainSshOwnerIdentifiedPanes());
        assert.equal(again.reason, "no-fence");
      }),
    ),
  );

  it.effect("drains at startup only when explicitly requested", () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.stubEnv("BIGBUD_SSH_OWNER_DRAIN_IDENTIFIED", "1");
        yield* boot({ ownerPresent: true });
        assert.equal(readSshOwnerAdmission().kind, "open");
        assert.equal(flags.starts, 1);
      }),
    ),
  );

  it.effect("starts the owner when the marker is present", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 185 });
        yield* retire(yield* SqlClient.SqlClient);
        yield* boot({ ownerPresent: true });
        assert.equal(readSshOwnerAdmission().kind, "open");
        assert.equal(flags.starts, 1);
      }),
    ),
  );

  it.effect("reports sshOwnerUnavailable when the owner is missing after a valid marker", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 185 });
        yield* retire(yield* SqlClient.SqlClient);
        yield* boot({ ownerPresent: false });
        const admission = readSshOwnerAdmission();
        assert.equal(admission.kind === "closed" && admission.error.code, "sshOwnerUnavailable");
        assert.equal(admission.kind === "closed" && admission.error.reason, "owner-missing");
        assert.equal(flags.starts, 0);
      }),
    ),
  );

  it.effect("keeps the fence when a previous drain left panes pending", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 185 });
        yield* retire(yield* SqlClient.SqlClient, ["thread-1:pane-1"]);
        yield* boot({ ownerPresent: true });
        const admission = readSshOwnerAdmission();
        assert.equal(admission.kind === "closed" && admission.error.reason, "legacy-panes-pending");
        const failed = yield* Effect.flip(drainSshOwnerIdentifiedPanes());
        assert.equal(failed.reason, "legacy-panes-pending");
        assert.equal(readSshOwnerAdmission().kind, "closed");
        assert.equal(flags.starts, 0);
      }),
    ),
  );
});
