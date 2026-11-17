import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { RemoteBackendProfiles } from "../../persistence/Services/RemoteBackendProfiles.ts";
import { RemoteBackendProfilesLive } from "../../persistence/Layers/RemoteBackendProfiles.ts";
import { readRemoteAgentApprovalEvidence } from "../../remote-agent/remoteAgentLocalControl.approval.ts";
import { makeRemoteAgentInstallSourceLoader } from "../../remote-agent/remoteAgentInstallSource.ts";
import { inspectSshHostTrust } from "../../ssh/sshHostTrust.ts";
import { RemoteBackendRelayProfiles } from "../clientRelay.profiles.ts";
import { makeDeploymentApproval } from "../deployment.approval.ts";
import { makePersistedRemoteBackendRelayProfiles } from "../deployment.profiles.store.ts";
import { makeDeploymentGraphSourceResolver } from "../deployment.source.ts";
import { runDeploymentSsh } from "../deployment.ssh.ts";
import { makeRemoteBackendDeployment } from "../deployment.ts";
import type { DeploymentProfileStore } from "../deployment.types.ts";
import { RemoteBackendDeployment } from "../Services/RemoteBackendDeployment.ts";

const makeServices = Effect.fn("makeRemoteBackendDeploymentServices")(function* () {
  const repository = yield* RemoteBackendProfiles;
  const projects = yield* ProjectionProjectRepository;
  const services = yield* Effect.services();
  const run = Effect.runPromiseWith(services);
  const store: DeploymentProfileStore = {
    list: () => run(repository.list()),
    get: (profileId) => run(repository.get(profileId)),
    findByRequestId: (requestId) => run(repository.findByRequestId(requestId)),
    findByTarget: (target) => run(repository.findByTarget(target)),
    insert: (record) => run(repository.insert(record)),
  };
  const sourceLoader = makeRemoteAgentInstallSourceLoader();
  const deployment = makeRemoteBackendDeployment({
    approval: makeDeploymentApproval({
      listSavedTargets: () =>
        run(projects.listAll()).then((rows) =>
          rows.map((row) => ({
            executionTargetId: row.executionTargetId,
            deleted: row.deletedAt !== null,
          })),
        ),
      evidence: (target) => readRemoteAgentApprovalEvidence(target),
    }),
    assertHostTrusted: (target) => inspectSshHostTrust(target),
    run: runDeploymentSsh,
    resolveSource: makeDeploymentGraphSourceResolver({
      environment: process.env,
      loadRustSource: (signal) => sourceLoader(signal),
    }),
    store,
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => deployment.dispose()));
  return { deployment, profiles: makePersistedRemoteBackendRelayProfiles(store) };
});

/** Local-backend composition: deployment plus the persisted relay profile directory. */
export const RemoteBackendDeploymentLive = Layer.unwrap(
  makeServices().pipe(
    Effect.map(({ deployment, profiles }) =>
      Layer.mergeAll(
        Layer.succeed(RemoteBackendDeployment, deployment),
        Layer.succeed(RemoteBackendRelayProfiles, profiles),
      ),
    ),
  ),
).pipe(Layer.provide(RemoteBackendProfilesLive));
