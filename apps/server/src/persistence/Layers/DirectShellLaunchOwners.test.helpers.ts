import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach } from "vitest";
import * as NodeSqlite from "../NodeSqliteClient";
import Migration from "../Migrations/170_DirectShellLaunchOwners";
import { makeDirectShellLaunchOwners } from "./DirectShellLaunchOwners";
import {
  directShellLaunchDigest,
  directShellOwnerKey,
  type DirectShellLaunchIntent,
  type DirectShellLaunchOwner,
} from "../../terminal/Layers/DirectShellLaunch.owner";
import { shellProfileId } from "../../terminal/Layers/ShellProfiles.identity";
import { remoteShellHost } from "../../terminal/Layers/ShellProfiles.remote.identity";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

export function owner(
  reservationId = "first",
  controllerId = "controller",
): DirectShellLaunchOwner {
  const executionTargetId = "ssh:host=example.test&user=tester&transport=direct-ssh";
  const host = remoteShellHost({ executionTargetId });
  const executable = "/bin/zsh";
  const args = ["-o", "nopromptsp"];
  const intent: DirectShellLaunchIntent = {
    executionTargetId,
    launch: {
      version: 1,
      cwd: "/home/tester",
      requestedProfile: {
        host,
        profileId: shellProfileId(host, executable, args, "linux"),
        kind: "zsh",
      },
      executable,
      args,
      platform: "linux",
      integration: "disabled",
    },
  };
  return {
    version: 1,
    ownerKey: directShellOwnerKey("thread", "pane"),
    reservationId,
    controllerId,
    intent,
    digest: directShellLaunchDigest(intent),
    state: "prepared",
  };
}

export async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bigbud-direct-owner-"));
  cleanups.push(async () => {
    rmSync(directory, { recursive: true, force: true });
  });
  const filename = join(directory, "owners.sqlite");
  const open = async () => {
    const runtime = ManagedRuntime.make(NodeSqlite.layer({ filename }));
    cleanups.push(() => runtime.dispose());
    return runtime;
  };
  const runtime = await open();
  await runtime.runPromise(Migration);
  const store = await runtime.runPromise(makeDirectShellLaunchOwners());
  const sql = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* SqlClient.SqlClient;
    }),
  );
  return { runtime, store, open, sql };
}
