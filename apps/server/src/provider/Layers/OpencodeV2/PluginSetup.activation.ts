import type { ServerSettingsShape } from "../../../ws/serverSettings.ts";
import { V2ConsentAuthority } from "./Application.consent.ts";
import { currentV2RequestContext } from "./Client.guard.ts";
import {
  V2ActivationJobs,
  type V2ActivationJobScope,
  type V2OwnedActivationJob,
  type V2ActivationHandle,
} from "./PluginSetup.activation.jobs.ts";
import { V2ActivationGate, type V2ReadyStamp } from "./PluginSetup.activation.gate.ts";
import { readV2ActivationIdle } from "./PluginSetup.activation.activity.ts";
import { resolveV2PluginConfigRoot } from "./PluginSetup.paths.ts";
import type { V2PluginSetupArtifact } from "./PluginSetup.record.ts";
import type { OpencodeV2Client } from "./Client.ts";
import { runV2ActivationTransaction } from "./PluginSetup.activation.transaction.ts";
import { hasOpencodeV2ManagedPluginTrust } from "@bigbud/shared/opencodeNativeTrust";
import { awaitV2ThreadToolsReady } from "./PluginSetup.activation.ready.ts";
import type { V2ReadinessFailure } from "./Orchestration.readiness.failure.ts";
import {
  verifyV2NativeEligibility,
  verifyV2NativeReadOnlyEligibility,
  type V2NativeEligibilityVerifier,
} from "./NativeCompatibility.runtime.ts";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";

export interface V2ActivationParticipant {
  readonly diagnostics?: () =>
    | {
        readonly threadId: string;
        readonly directory: string;
        readonly implementationDigest: string;
      }
    | undefined;
  readonly busyCount: () => number;
  readonly controlCount: () => number;
  readonly pauseRenewal: () => void;
  readonly resumeRenewal: () => void;
  readonly joinControl: (signal: AbortSignal) => Promise<void>;
  readonly retire: (signal: AbortSignal) => Promise<void>;
}
interface Scope {
  readonly gate: V2ActivationGate;
  readonly participants: Map<string, V2ActivationParticipant>;
}
interface Proposal {
  readonly artifact: V2PluginSetupArtifact;
  readonly directories: Set<string>;
  readonly scope: Scope;
}

/** One injected coordinator for settings and every local runtime. Construction subscribes only; no native/artifact I/O. */
export class V2ThreadToolsActivation {
  readonly consent: V2ConsentAuthority;
  readonly jobs: V2ActivationJobs;
  private readonly scopes = new Map<string, Scope>();
  private readonly proposals = new Map<string, Proposal>();
  private readonly issued = new Map<string, { scope: V2ActivationJobScope; directory: string }>();
  private closed = false;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly settings: ServerSettingsShape,
    private readonly eligibility: V2NativeEligibilityVerifier = verifyV2NativeEligibility,
  ) {
    this.consent = new V2ConsentAuthority(settings);
    this.jobs = new V2ActivationJobs(this.consent, (job) => this.activate(job));
    let revision = this.consent.currentRevision();
    const unsubscribe =
      settings.onSnapshotChange?.(() => {
        const current = this.consent.currentRevision();
        if (current === revision) return;
        revision = current;
        for (const scope of this.scopes.values()) scope.gate.invalidate();
      }) ?? (() => {});
    this.unsubscribe = typeof unsubscribe === "function" ? unsubscribe : () => {};
  }
  private key(scope: V2ActivationJobScope) {
    return JSON.stringify([
      scope.root,
      scope.issuer,
      scope.transport,
      scope.generation,
      scope.registrationId,
    ]);
  }
  scopeFor(artifact: V2PluginSetupArtifact, descriptor: V2ActivationJobScope["descriptor"]) {
    const context = currentV2RequestContext(),
      settings = this.settings.currentSnapshot?.()?.settings.providers.opencodeV2;
    context?.permit.assertCurrent();
    if (
      this.closed ||
      !context ||
      context.intent !== "execute" ||
      !settings?.enabled ||
      !hasOpencodeV2ManagedPluginTrust(settings) ||
      context.transport !== descriptor.registrationFile
    )
      throw new Error(
        "V2 expanded acknowledged activation scope is unavailable; no setup interest or write.",
      );
    const scope: V2ActivationJobScope = {
      root: resolveV2PluginConfigRoot(settings.nativePluginConfigRoot),
      issuer: artifact.issuer,
      registrationId: v2ThreadRegistration(artifact).id,
      transport: descriptor.registrationFile,
      generation: descriptor.generation,
      digest: artifact.artifactDigest,
      consentRevision: this.consent.currentRevision(),
      descriptor,
    };
    const key = this.key(scope);
    let registered = this.scopes.get(key);
    if (!registered) {
      if (this.scopes.size >= 32)
        throw new Error("V2 activation scope/quarantine capacity reached.");
      registered = {
        gate: new V2ActivationGate(key, scope.digest, () => {
          const current = this.settings.currentSnapshot?.()?.settings.providers.opencodeV2;
          if (
            this.closed ||
            !current?.enabled ||
            !hasOpencodeV2ManagedPluginTrust(current) ||
            resolveV2PluginConfigRoot(current.nativePluginConfigRoot) !== scope.root
          )
            throw new Error("V2 activation scope consent/generation changed.");
        }),
        participants: new Map(),
      };
      this.scopes.set(key, registered);
    }
    return { scope, ...registered };
  }
  registerOwner(gate: V2ActivationGate, exactKey: string, participant: V2ActivationParticipant) {
    const scope = this.scopes.get(gate.scope);
    if (
      !scope ||
      scope.gate !== gate ||
      scope.participants.has(exactKey) ||
      scope.participants.size >= 32
    )
      throw new Error("V2 activation owner capacity/identity rejected.");
    scope.participants.set(exactKey, participant);
    return () => {
      if (scope.participants.get(exactKey) !== participant)
        throw new Error("V2 activation owner successor preserved.");
      if (participant.busyCount() || participant.controlCount())
        throw new Error("V2 unresolved activation owner must remain quarantined.");
      scope.participants.delete(exactKey);
    };
  }
  requestSetup(
    artifact: V2PluginSetupArtifact,
    descriptor: V2ActivationJobScope["descriptor"],
    directory: string,
    signal?: AbortSignal,
    readinessFailure?: V2ReadinessFailure,
  ) {
    const owned = this.scopeFor(artifact, descriptor),
      key = this.key(owned.scope);
    let proposal = this.proposals.get(key);
    if (proposal && proposal.artifact.artifactDigest !== artifact.artifactDigest)
      proposal = undefined;
    if (!proposal)
      proposal = {
        artifact,
        directories: new Set(),
        scope: { gate: owned.gate, participants: owned.participants },
      };
    if (!proposal.directories.has(directory) && proposal.directories.size >= 64)
      throw new Error("V2 activation Location capacity reached.");
    const handle = this.jobs.request(
      { ...owned.scope, ...(readinessFailure ? { readinessFailure } : {}) },
      signal,
    );
    this.proposals.set(key, proposal);
    proposal.directories.add(directory);
    if (!this.issued.has(handle.jobId) && this.issued.size >= 32)
      for (const id of this.issued.keys())
        if (this.jobs.isSettled(id)) {
          this.issued.delete(id);
          break;
        }
    this.issued.set(handle.jobId, { scope: owned.scope, directory });
    return { handle, scope: owned.scope, gate: owned.gate };
  }
  async awaitReady(
    artifact: V2PluginSetupArtifact,
    descriptor: V2ActivationJobScope["descriptor"],
    client: OpencodeV2Client,
    directory: string,
    signal?: AbortSignal,
  ): Promise<{ gate: V2ActivationGate; stamp: V2ReadyStamp }> {
    return awaitV2ThreadToolsReady(this, artifact, descriptor, client, directory, signal);
  }
  status(handle: V2ActivationHandle, scope: V2ActivationJobScope) {
    return this.jobs.status(handle.jobId, scope);
  }
  cancelInterest(handle: V2ActivationHandle, scope: V2ActivationJobScope) {
    this.jobs.cancel(handle, scope);
  }
  get nativeEligibility() {
    return this.eligibility;
  }
  activeImplementation(
    artifact: V2PluginSetupArtifact,
    descriptor: V2ActivationJobScope["descriptor"],
    directory: string,
    threadId: string,
  ) {
    const settings = this.settings.currentSnapshot?.()?.settings.providers.opencodeV2;
    if (this.closed || !settings?.enabled || !hasOpencodeV2ManagedPluginTrust(settings))
      return undefined;
    const key = JSON.stringify([
      resolveV2PluginConfigRoot(settings.nativePluginConfigRoot),
      artifact.issuer,
      descriptor.registrationFile,
      descriptor.generation,
      v2ThreadRegistration(artifact).id,
    ]);
    const scope = this.scopes.get(key);
    if (!scope) return undefined; // Passive diagnostics never create a scope/job or inspect a foreign owner.
    const matches = [...scope.participants.values()]
      .map((participant) => participant.diagnostics?.())
      .filter((owner) => owner?.threadId === threadId && owner.directory === directory);
    return matches.length === 1 ? matches[0]?.implementationDigest : undefined;
  }
  lookup(jobId: string, interestId?: string) {
    const issued = this.issued.get(jobId),
      settings = this.settings.currentSnapshot?.()?.settings.providers.opencodeV2;
    if (
      !issued ||
      this.closed ||
      !settings?.enabled ||
      !hasOpencodeV2ManagedPluginTrust(settings) ||
      issued.scope.consentRevision !== this.consent.currentRevision() ||
      resolveV2PluginConfigRoot(settings.nativePluginConfigRoot) !== issued.scope.root ||
      (settings.serviceFile?.trim() && settings.serviceFile.trim() !== issued.scope.transport)
    )
      throw new Error(
        "V2 activation status/cancellation handle belongs to a changed or absent scope.",
      );
    if (interestId) this.jobs.cancel({ jobId, interestId }, issued.scope);
    return { directory: issued.directory, ...this.jobs.status(jobId, issued.scope) };
  }
  private async activate(job: V2OwnedActivationJob) {
    const proposal = this.proposals.get(this.key(job.scope));
    if (!proposal) throw new Error("V2 activation proposal is missing.");
    try {
      await verifyV2NativeReadOnlyEligibility(
        proposal.artifact,
        job.connection.client,
        [...proposal.directories][0]!,
        job.scope.root,
        job.signal,
        this.eligibility,
      );
      job.assertCurrent();
      await runV2ActivationTransaction(
        job,
        proposal,
        this.settings,
        this.consent,
        (signal) => readV2ActivationIdle(job, proposal, signal),
        this.eligibility,
      );
    } finally {
      if (this.proposals.get(this.key(job.scope)) === proposal)
        this.proposals.delete(this.key(job.scope));
    }
  }
  async close() {
    this.closed = true;
    this.unsubscribe();
    for (const scope of this.scopes.values()) scope.gate.invalidate();
    await this.jobs.close();
    this.consent.close();
  }
  passiveReady(
    descriptor: V2ActivationJobScope["descriptor"],
    directory: string,
    artifact?: V2PluginSetupArtifact,
  ) {
    currentV2RequestContext()?.permit.assertCurrent();
    for (const [key, scope] of this.scopes) {
      const fields = JSON.parse(key) as unknown[];
      if (
        fields[2] === descriptor.registrationFile &&
        fields[3] === descriptor.generation &&
        (!artifact || fields[4] === v2ThreadRegistration(artifact).id)
      ) {
        const stamp = scope.gate.knownReady(directory);
        if (stamp) return { gate: scope.gate, stamp };
      }
    }
    throw new Error(
      "V2 hidden work has no passive verified Location admission; it cannot activate an installer or acquire canonical credentials.",
    );
  }
}
