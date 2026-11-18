import * as Schema from "effect/Schema";
import {
  RemoteBackendDeploymentError,
  type RemoteBackendDeploymentInput,
  type RemoteBackendDeploymentResult,
} from "@bigbud/contracts/server/remoteBackendDeployment.ts";
import type { RemoteBackendProfileRecord } from "../persistence/Services/RemoteBackendProfiles.ts";
import { formatSshDestination, parseSshExecutionTarget } from "../ssh/sshExecutionTarget.ts";
import {
  putRemoteSetupInput,
  relayHelperPath,
  stageRemoteBackendGraph,
} from "./deployment.fetch.ts";
import {
  probeRemoteBackendHost,
  readRemoteSetupCompletion,
  runRemoteBackendSetup,
  runRemoteBackendStart,
} from "./deployment.remoteSetup.ts";
import {
  deploymentError,
  DEPLOYMENT_REQUEST_ID,
  type DeploymentApproval,
  type DeploymentGraphSourceResolver,
  type DeploymentProfileStore,
  type DeploymentRemoteRunner,
} from "./deployment.types.ts";

export interface RemoteBackendDeploymentDependencies {
  readonly approval: (executionTargetId: string) => Promise<DeploymentApproval>;
  /** Interactive known-hosts check before any command; the runner also uses strict host keys. */
  readonly assertHostTrusted: (executionTargetId: string) => Promise<void>;
  readonly run: DeploymentRemoteRunner;
  readonly resolveSource: DeploymentGraphSourceResolver;
  readonly store: DeploymentProfileStore;
  readonly now?: () => string;
}
interface Active {
  readonly executionTargetId: string;
  readonly enableBoot: boolean;
  readonly promise: Promise<RemoteBackendDeploymentResult>;
}

export const deploymentResult = (
  record: RemoteBackendProfileRecord,
): RemoteBackendDeploymentResult => ({
  profileId: record.profileId,
  authority: {
    authorityId: record.authorityId,
    keyFingerprint: record.keyFingerprint,
    keyEpoch: record.keyEpoch,
  },
  status: record.bootEnabled ? "enabled" : "started",
});

function label(executionTargetId: string): string {
  const target = parseSshExecutionTarget(executionTargetId);
  return (target ? formatSshDestination(target) : "Remote backend").slice(0, 256);
}

/**
 * Laptop-driven backend deployment (WP-3A). Idempotent by `requestId`: a repeat joins the running
 * operation or returns the persisted profile. The operation owns its own cancellation, so a lost
 * caller never interrupts remote setup midway; the caller may re-join with the same request.
 */
export function makeRemoteBackendDeployment(deps: RemoteBackendDeploymentDependencies) {
  const active = new Map<string, Active>();
  const lifetime = new AbortController();
  const now = deps.now ?? (() => new Date().toISOString());

  async function deploy(input: RemoteBackendDeploymentInput, signal: AbortSignal) {
    const { executionTargetId: target, requestId, enableBoot } = input;
    const existing = await deps.store.findByRequestId(requestId);
    if (existing) {
      if (existing.executionTargetId !== target || existing.bootEnabled !== enableBoot)
        throw deploymentError("conflict", "This request id already deployed another selection.");
      return deploymentResult(existing);
    }
    const approval = await deps.approval(target);
    if (approval.hostTrustFailure) throw deploymentError("unavailable", approval.hostTrustFailure);
    if (!approval.approved)
      throw deploymentError(
        "approval-required",
        "This host has not been approved in bigbud. Install the remote agent on it first.",
      );
    await deps.assertHostTrusted(target).catch(() => {
      throw deploymentError("unavailable", "The SSH host identity could not be verified.");
    });
    const probe = await probeRemoteBackendHost(deps.run, target, requestId, signal);
    const previous = await deps.store.findByTarget(target);
    if (previous && previous.hostIdentity !== probe.hostIdentity)
      throw deploymentError("host-changed", "The SSH host identity differs from its profile.");
    if (previous)
      throw deploymentError("conflict", "This host already has a deployed backend profile.");
    const source = await deps.resolveSource(probe.target, signal);
    const staged = await stageRemoteBackendGraph({
      executionTargetId: target,
      requestId,
      remoteHome: probe.home,
      source,
      run: deps.run,
      signal,
    });
    const paths = {
      home: probe.home,
      installDir: staged.installDir,
      graphRoot: staged.graphRoot,
      nodeBinary: `${staged.graphRoot}/${source.manifest.node}`,
      entry: `${staged.graphRoot}/${source.manifest.entry}`,
    };
    let authorityId = probe.completedAuthorityId;
    if (!authorityId) {
      const upload = (name: "rust-manifest.json" | "trusted-keys.json", text: string) =>
        putRemoteSetupInput({
          executionTargetId: target,
          requestId,
          name,
          text,
          run: deps.run,
          signal,
        });
      const rustManifest = await upload("rust-manifest.json", source.rustManifestJson);
      const trustedKeys = await upload("trusted-keys.json", JSON.stringify(source.trustedKeys));
      authorityId = await runRemoteBackendSetup({
        run: deps.run,
        executionTargetId: target,
        requestId,
        paths: { ...paths, rustManifest, trustedKeys },
        signal,
      });
    }
    await runRemoteBackendStart({
      run: deps.run,
      executionTargetId: target,
      authorityId,
      enableBoot,
      paths,
      signal,
    });
    const completion = await readRemoteSetupCompletion({
      run: deps.run,
      executionTargetId: target,
      authorityId,
      requestId,
      signal,
    });
    const helper = relayHelperPath(source);
    const stored = await deps.store.insert({
      profileId: `rb-${authorityId}`,
      requestId,
      executionTargetId: target,
      label: label(target),
      authorityId,
      keyFingerprint: completion.authority.keyFingerprint,
      keyEpoch: completion.authority.keyEpoch,
      installationFingerprint: completion.installationFingerprint,
      hostIdentity: probe.hostIdentity,
      remoteHome: probe.home,
      graphVersion: source.manifest.version,
      graphTarget: source.manifest.target,
      graphArchiveSha256: source.archiveSha256,
      graphManifestSha256: source.manifestSha256,
      graphRoot: staged.graphRoot,
      nodeBinary: paths.nodeBinary,
      nodeSha256: source.manifest.files.find((file) => file.path === source.manifest.node)!.sha256,
      helperEntry: `${staged.graphRoot}/${helper}`,
      helperSha256: source.manifest.files.find((file) => file.path === helper)!.sha256,
      bootEnabled: enableBoot,
      createdAt: now(),
    });
    return deploymentResult(stored);
  }

  return {
    setupRemoteBackend(
      input: RemoteBackendDeploymentInput,
      caller: AbortSignal,
    ): Promise<RemoteBackendDeploymentResult> {
      if (
        !DEPLOYMENT_REQUEST_ID.test(input.requestId) ||
        typeof input.enableBoot !== "boolean" ||
        !input.executionTargetId.startsWith("ssh:")
      )
        return Promise.reject(deploymentError("invalid-target", "Invalid deployment request."));
      const joined = active.get(input.requestId);
      let promise: Promise<RemoteBackendDeploymentResult>;
      if (joined) {
        if (
          joined.executionTargetId !== input.executionTargetId ||
          joined.enableBoot !== input.enableBoot
        )
          return Promise.reject(deploymentError("conflict", "Request id reused for another host."));
        promise = joined.promise;
      } else {
        if (
          [...active.values()].some((entry) => entry.executionTargetId === input.executionTargetId)
        )
          return Promise.reject(deploymentError("busy", "This host is already being deployed."));
        promise = deploy(input, lifetime.signal).catch((error: unknown) => {
          if (Schema.is(RemoteBackendDeploymentError)(error)) throw error;
          if ((error as { _tag?: unknown })?._tag === "RemoteBackendProfileConflict")
            throw deploymentError("conflict", "A different profile holds this backend identity.");
          throw deploymentError("unavailable", "Remote backend deployment failed.");
        });
        const entry = { ...input, promise };
        active.set(input.requestId, entry);
        void promise
          .catch(() => {})
          .finally(() => {
            if (active.get(input.requestId) === entry) active.delete(input.requestId);
          });
      }
      // The caller may stop waiting; the operation keeps running and can be re-joined.
      return new Promise((resolve, reject) => {
        const stop = () => reject(caller.reason ?? new Error("Deployment wait canceled."));
        if (caller.aborted) return stop();
        caller.addEventListener("abort", stop, { once: true });
        promise.then(resolve, reject).finally(() => caller.removeEventListener("abort", stop));
      });
    },
    dispose() {
      lifetime.abort(new Error("Remote backend deployment service stopped."));
    },
  };
}
export type RemoteBackendDeployment = ReturnType<typeof makeRemoteBackendDeployment>;
