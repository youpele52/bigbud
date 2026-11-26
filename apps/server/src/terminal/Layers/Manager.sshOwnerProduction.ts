import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeRemoteAgentRuntimeBindings } from "../../persistence/Layers/RemoteAgentRuntimeBindings.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { makeLazySshOwnerProductionTerminal } from "../../ssh/sshOwnerProductionTerminal.lazy.ts";
import { readSshOwnerProductionOwner } from "../../ssh/sshOwnerProductionRegistry.ts";
import { makeProductionShellProfiles } from "./ShellProfiles.sshOwner.ts";

/**
 * W2 T-term: the production direct-SSH terminal composition for the terminal
 * manager. Every direct SSH pane runs through the live Rust owner.
 */
export const makeProductionSshTerminal = Effect.fn("makeProductionSshTerminal")(function* (
  sql: SqlClient.SqlClient,
) {
  const owners = yield* makeRemoteAgentRuntimeBindings.pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.orDie,
  );
  const projects = yield* Effect.serviceOption(ProjectionProjectRepository);
  const services = yield* Effect.services<never>();
  // The live target set for quit: every non-deleted project's execution target.
  const targets = async (): Promise<ReadonlyArray<string>> => {
    if (Option.isNone(projects)) return [];
    const rows = await Effect.runPromiseWith(services)(projects.value.listAll());
    return [
      ...new Set(
        rows.filter((row) => row.deletedAt === null).map((row) => String(row.executionTargetId)),
      ),
    ];
  };
  const shellProfiles = makeProductionShellProfiles(readSshOwnerProductionOwner);
  const terminal = makeLazySshOwnerProductionTerminal({
    read: readSshOwnerProductionOwner,
    owners: () => owners,
    targets,
    shellFor: shellProfiles.shellFor,
  });
  return { ...terminal, shellProfiles };
});
