import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, it } from "@effect/vitest";
import { SSH_OWNER_ADMISSION_WS_METHODS } from "@bigbud/contracts/server/sshOwnerAdmission.ts";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, vi } from "vitest";

import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  LEGACY_RETIREMENT_PROFILE_SCOPE,
  readLegacyRetirement,
} from "../persistence/Layers/LegacyRetirement.ts";
import {
  registerLocalTerminalHostRetirementSource,
  resetLocalTerminalHostRetirementSourceForTest,
} from "../terminal-host/localTerminalHost.retirementSource.ts";
import { makeWsRpcSshOwnerAdmissionHandlers } from "../ws/wsRpcHandlers.sshOwnerAdmission.ts";
import {
  bootActivatedStartup,
  clearLegacyRetirement,
  fakeTerminalHost,
  hostPane,
} from "./sshOwner.productionStartup.fixture.ts";
import {
  readSshOwnerAdmission,
  resetSshOwnerProductionStateForTest,
} from "./sshOwnerProductionComposition.ts";

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
  root = await mkdtemp(join(await realpath(tmpdir()), "ssh-owner-host-drain-"));
  resetSshOwnerProductionStateForTest();
  resetLocalTerminalHostRetirementSourceForTest();
  flags.starts = 0;
});
afterEach(async () => {
  resetSshOwnerProductionStateForTest();
  resetLocalTerminalHostRetirementSourceForTest();
  await rm(root, { recursive: true, force: true });
});

const rpc = makeWsRpcSshOwnerAdmissionHandlers();

it.layer(NodeSqliteClient.layerMemory())("B-side drain through the X2 host and the RPC", (it) => {
  it.effect("lists host SSH panes over RPC, retires exactly them, then writes the marker", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* clearLegacyRetirement;
        const host = fakeTerminalHost({
          panes: [hostPane("ssh-1", "managed-ssh"), hostPane("local-1", "local")],
          retirementCapability: true,
        });
        registerLocalTerminalHostRetirementSource(host.source);
        const sql = yield* bootActivatedStartup(root, { ownerPresent: true });

        const fenced = yield* rpc[SSH_OWNER_ADMISSION_WS_METHODS.get]();
        assert.equal(fenced.state, "fenced");
        assert.deepEqual(fenced.state === "fenced" ? fenced.panes : [], [
          { identity: "host-1:ssh-1", threadId: "thread-ssh-1", paneId: "pane-ssh-1" },
        ]);
        assert.deepEqual(host.retired, []);

        const after = yield* rpc[SSH_OWNER_ADMISSION_WS_METHODS.drain]();
        assert.deepEqual(after, { state: "open" });
        assert.deepEqual(host.retired, [["ssh-1"]]);
        assert.equal(flags.starts, 1);
        const record = yield* readLegacyRetirement(sql, LEGACY_RETIREMENT_PROFILE_SCOPE);
        assert.deepEqual(record?.record.drainedLeases, ["host-1:ssh-1"]);

        const again = yield* Effect.flip(rpc[SSH_OWNER_ADMISSION_WS_METHODS.drain]());
        assert.equal(again.code, "no-fence");
      }),
    ),
  );

  it.effect("requires host exit when the host lacks terminal.host-retirement", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* clearLegacyRetirement;
        const host = fakeTerminalHost({
          panes: [hostPane("ssh-1", "managed-ssh")],
          retirementCapability: false,
        });
        registerLocalTerminalHostRetirementSource(host.source);
        const sql = yield* bootActivatedStartup(root, { ownerPresent: true });

        const fenced = yield* rpc[SSH_OWNER_ADMISSION_WS_METHODS.get]();
        assert.equal(fenced.state === "fenced" && typeof fenced.listError, "string");
        const refused = yield* Effect.flip(rpc[SSH_OWNER_ADMISSION_WS_METHODS.drain]());
        assert.equal(refused.code, "host-exit-required");
        assert.equal(yield* readLegacyRetirement(sql, LEGACY_RETIREMENT_PROFILE_SCOPE), undefined);
        assert.equal(readSshOwnerAdmission().kind, "closed");
        assert.equal(flags.starts, 0);
        assert.equal(
          host.connection.request.mock.calls.length,
          0,
          "no verb is sent to a host without the capability",
        );
      }),
    ),
  );

  it.effect("drains with no attached host and reports open over RPC", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* clearLegacyRetirement;
        yield* bootActivatedStartup(root, { ownerPresent: true });
        // No attached host means no legacy SSH panes; the marker records none.
        yield* rpc[SSH_OWNER_ADMISSION_WS_METHODS.drain]();
        assert.deepEqual(yield* rpc[SSH_OWNER_ADMISSION_WS_METHODS.get](), { state: "open" });
      }),
    ),
  );
});
