/**
 * Test-only launcher for `sshOwner.productionClient.launcherLifetime.native.test.ts`:
 * starts one production owner for `<state-dir>` with `<kind>`, prints `ready`, then
 * idles until it is killed. It never shuts the owner down.
 */
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import type { SshOwnerProfile } from "./sshOwnerProductionArtifact.ts";
import { resolveSshOwnerLaunchFacts } from "./sshOwnerProductionClient.launch.ts";
import { startOrAttachSshOwnerProduction } from "./sshOwnerProductionClient.ts";
import { findWorkspaceAgentTarget } from "../../../../scripts/lib/workspace-agent-target.ts";

const [root, ownerPath, kind] = process.argv.slice(2) as [string, string, SshOwnerProfile];
const stateDirectory = join(root, "state");
const facts = resolveSshOwnerLaunchFacts({ stateDirectory, kind });
const layer = makeSqlitePersistenceLive(join(root, "launcher.sqlite"), { worker: false }).pipe(
  Layer.provide(NodeServices.layer),
);
await Effect.runPromise(
  Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
    startOrAttachSshOwnerProduction({
      artifact: {
        profile: kind,
        path: ownerPath,
        target: findWorkspaceAgentTarget(process.platform, process.arch)!,
        evidence: "header",
      },
      facts,
      sql,
    }),
  ).pipe(Effect.provide(layer)),
);
process.stdout.write("ready\n");
setInterval(() => {}, 1_000);
