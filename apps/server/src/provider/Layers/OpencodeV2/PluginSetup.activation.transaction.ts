import { setTimeout as delay } from "node:timers/promises";
import type { ServerSettingsShape } from "../../../ws/serverSettings.ts";
import type { V2ConsentAuthority } from "./Application.consent.ts";
import type { V2OwnedActivationJob } from "./PluginSetup.activation.jobs.ts";
import type { V2ActivationGate } from "./PluginSetup.activation.gate.ts";
import type { V2ActivationParticipant } from "./PluginSetup.activation.ts";
import type { V2PluginSetupArtifact } from "./PluginSetup.record.ts";
import { makeV2AutomaticPluginSetup } from "./PluginSetup.native.ts";
import { assertV2PluginUpgradeIdle } from "./PluginSetup.upgrade.ts";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";
import { verifyV2ThreadTools } from "./Orchestration.readiness.ts";
import {
  verifyV2NativeEligibility,
  type V2NativeEligibilityVerifier,
} from "./NativeCompatibility.runtime.ts";
import type { V2NativeRuntimeProof } from "./NativeCompatibility.types.ts";
import { assertV2NativeRuntimePolicy } from "./NativeCompatibility.policy.ts";
import { V2ActivationWindow } from "./PluginSetup.activation.window.ts";
import { V2ActivationBusy } from "./PluginSetup.activation.errors.ts";
import { makeV2IdentityPublication } from "./PluginSetup.activation.identity.ts";

interface Proposal {
  readonly artifact: V2PluginSetupArtifact;
  readonly directories: Set<string>;
  readonly scope: {
    readonly gate: V2ActivationGate;
    readonly participants: ReadonlyMap<string, V2ActivationParticipant>;
  };
}

/** Retry only proven pre-publication busy races; joins never extend the job's creation deadline. */
export async function runV2ActivationTransaction(
  job: V2OwnedActivationJob,
  proposal: Proposal,
  settings: ServerSettingsShape,
  consent: V2ConsentAuthority,
  idle: (signal?: AbortSignal) => Promise<boolean>,
  eligibility: V2NativeEligibilityVerifier = verifyV2NativeEligibility,
) {
  let backoff = 2000;
  for (;;) {
    job.assertCurrent();
    try {
      return await activationAttempt(job, proposal, settings, consent, idle, eligibility);
    } catch (error) {
      if (!(error instanceof V2ActivationBusy)) throw error;
      job.assertCurrent();
      job.phase(
        "waiting-for-idle",
        "V2 known work won a pre-publication race; the same job is waiting without cancelling it.",
      );
      await delay(backoff, undefined, { signal: job.signal });
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

async function activationAttempt(
  job: V2OwnedActivationJob,
  proposal: Proposal,
  settings: ServerSettingsShape,
  consent: V2ConsentAuthority,
  idle: (signal?: AbortSignal) => Promise<boolean>,
  eligibility: V2NativeEligibilityVerifier,
) {
  const gate = proposal.scope.gate;
  let closed = false,
    publicationPrepared = false,
    physicalFsMutationIssued = false,
    window: V2ActivationWindow | undefined,
    currentProof: V2NativeRuntimeProof | undefined;
  const freshAuthority = async (signal: AbortSignal) => {
    job.assertCurrent();
    const proof = await eligibility(
      proposal.artifact,
      job.connection.client,
      [...proposal.directories][0]!,
      job.scope.root,
      signal,
    );
    job.assertCurrent();
    signal.throwIfAborted();
    await assertV2NativeRuntimePolicy(
      job.connection.client,
      proof,
      signal,
      v2ThreadRegistration(proposal.artifact),
    );
    job.assertCurrent();
    signal.throwIfAborted();
    proof.assertCurrent();
    currentProof = proof;
  };
  const identity = makeV2IdentityPublication(
    job,
    gate,
    proposal.scope.participants,
    freshAuthority,
  );
  const publication = {
    identityRevalidation: identity.authority,
    joinPhysicalOnCancel: true as const,
    assertGate: () => {
      currentProof?.assertCurrent();
      if (closed) {
        window?.assertCurrent();
        gate.assertGate(job.id);
      } else window?.signal.throwIfAborted();
    },
    mutationIssued: () => {
      currentProof?.assertCurrent();
      window?.assertCurrent();
      gate.assertGate(job.id);
      physicalFsMutationIssued = true;
    },
    observePhysical: (operation: Promise<unknown>) => window?.observe(operation),
    joinPhysical: async () => {
      await window?.drain();
    },
    prepare: async () => {
      job.phase("prepared");
      let backoff = 2000;
      while (!(await idle(job.signal))) {
        job.phase("waiting-for-idle");
        await delay(backoff, undefined, { signal: job.signal });
        backoff = Math.min(backoff * 2, 30000);
        job.assertCurrent();
      }
    },
    locked: async () => {
      job.phase("closing-gate");
      if (!gate.tryCloseGate(job.id))
        throw new V2ActivationBusy("V2 activation lost the local admission race.");
      closed = true;
      const participants = [...proposal.scope.participants.values()];
      for (const owner of participants) owner.pauseRenewal();
      const release = () => {
        if (!closed) return;
        closed = false;
        gate.releaseGate(job.id);
        window?.release();
        for (const owner of participants) owner.resumeRenewal();
      };
      window = new V2ActivationWindow(gate.gateDeadline(job.id), job.signal, () => {
        release();
        if (!job.signal.aborted)
          job.phase(
            "uncertain",
            "V2 short gate expired; physical settlement remains owned and no new operation is authorized.",
          );
      });
      try {
        return await window.run(async () => {
          if (participants.some((owner) => owner.busyCount()))
            throw new V2ActivationBusy("V2 callback/execution admitted before gate closure.");
          for (const owner of participants) {
            window!.assertCurrent();
            gate.assertGate(job.id);
            await owner.joinControl(window!.signal);
            window!.assertCurrent();
            gate.assertGate(job.id);
          }
          if (!(await idle(window!.signal)))
            throw new V2ActivationBusy(
              "V2 known work became busy after control join; no owner retired.",
            );
          window!.assertCurrent();
          await freshAuthority(window!.signal);
          gate.assertGate(job.id);
          job.phase("retiring");
          for (const owner of participants) {
            window!.assertCurrent();
            gate.assertGate(job.id);
            if (!(await idle(window!.signal)))
              throw new V2ActivationBusy(
                "V2 known work became busy before owner retirement; no busy owner will be detached.",
              );
            window!.assertCurrent();
            gate.assertGate(job.id);
            await owner.retire(window!.signal);
            window!.assertCurrent();
            gate.assertGate(job.id);
          }
          await assertV2PluginUpgradeIdle(proposal.artifact);
          window!.assertCurrent();
          gate.assertGate(job.id);
          return release;
        });
      } catch (error) {
        if (!(error instanceof V2ActivationBusy) && window.hasPending())
          job.phase(
            "uncertain",
            "V2 physical cleanup remains owned after its observer stopped; no automatic retry.",
          );
        window.controller.abort();
        release();
        throw error;
      }
    },
    beforeMutation: async () => {
      if (!window) throw new Error("V2 publication has no short gate budget.");
      await window.run(async () => {
        gate.assertGate(job.id);
        if (!(await idle(window!.signal)))
          throw new V2ActivationBusy(
            "V2 known work became busy before publication; target entry is unchanged.",
          );
        window!.assertCurrent();
        gate.assertGate(job.id);
        await freshAuthority(window!.signal);
        window!.assertCurrent();
        gate.assertGate(job.id);
        job.phase("publishing");
        gate.beforePublication(job.id, job.scope.digest);
        publicationPrepared = true;
      });
    },
  };
  try {
    const installed = await makeV2AutomaticPluginSetup(settings, consent, publication, eligibility)(
      proposal.artifact,
      job.connection.client,
      [...proposal.directories][0]!,
      job.signal,
    );
    if (installed.artifactDigest !== proposal.artifact.artifactDigest)
      gate.adoptRetained(installed.artifactDigest);
    job.phase("verifying");
    let verifiedProof: V2NativeRuntimeProof | undefined;
    for (const directory of proposal.directories) {
      job.assertCurrent();
      const info = await verifyV2ThreadTools(
        installed,
        job.connection.client,
        directory,
        job.signal,
        undefined,
        eligibility,
        job.scope.root,
      );
      gate.verify(directory, info.bootstrapDigest, info.setupInstanceId, info.nativeProof);
      verifiedProof = info.nativeProof;
    }
    job.installed(installed.artifactDigest, verifiedProof);
  } catch (error) {
    if (publicationPrepared || physicalFsMutationIssued) gate.invalidate(job.scope.digest);
    if (
      physicalFsMutationIssued ||
      publicationPrepared ||
      (!(error instanceof V2ActivationBusy) &&
        (window?.hasPending() || (window?.signal.aborted && !job.signal.aborted)))
    )
      job.phase(
        "uncertain",
        "V2 short gate expired; issued physical operations remain owned until settlement.",
      );
    if (error instanceof V2ActivationBusy && (physicalFsMutationIssued || publicationPrepared))
      // oxlint-disable-next-line preserve-caught-error -- The busy signal is superseded; the uncertain-publication message is the contract.
      throw new Error(
        "V2 publication may already have been issued; no busy retry or rollback is authorized.",
      );
    throw error;
  } finally {
    if (closed) {
      closed = false;
      gate.releaseGate(job.id);
    }
    window?.release();
    await window?.drain();
    await identity.close();
  }
}
