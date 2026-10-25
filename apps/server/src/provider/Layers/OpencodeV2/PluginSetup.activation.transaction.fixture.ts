import path from "node:path";
import { mkdir } from "node:fs/promises";
import { Effect } from "effect";
import { vi } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { makeV2ActivationJobsFixture } from "./PluginSetup.activation.jobs.fixture.ts";
import { V2ActivationJobs } from "./PluginSetup.activation.jobs.ts";
import { V2ActivationGate } from "./PluginSetup.activation.gate.ts";
import { runV2ActivationTransaction } from "./PluginSetup.activation.transaction.ts";
import { currentV2RequestContext } from "./Client.guard.ts";
import type { OpencodeV2Client } from "./Client.ts";
import type { V2NativeRuntimeProof } from "./NativeCompatibility.types.ts";
import type { V2ActivationParticipant } from "./PluginSetup.activation.ts";
import { deferred } from "./Test.fixtures.ts";
import { readV2ActivationIdle } from "./PluginSetup.activation.activity.ts";

/** Actual jobs/transaction/signed publication; only native API/qualification claims are synthetic. */
export async function makeV2ActivationTransactionFixture(
  idle?: (signal?: AbortSignal) => Promise<boolean>,
) {
  const app = await makeV2ThreadPluginFixture(),
    f = await makeV2ActivationJobsFixture(),
    root = path.join(app.root, "owned-config"),
    waiting = deferred<void>();
  await mkdir(root, { mode: 0o700 });
  await Effect.runPromise(
    f.settings.updateSettings({ providers: { opencodeV2: { nativePluginConfigRoot: root } } }),
  );
  const scope = {
    ...f.scope,
    root,
    issuer: app.artifact.issuer,
    digest: app.artifact.artifactDigest,
    consentRevision: f.consent.currentRevision(),
  };
  const gate = new V2ActivationGate(
    JSON.stringify([root, scope.issuer, scope.transport, scope.generation]),
    scope.digest,
    () => {},
  );
  const client = {
    config: { get: async () => [{ type: "directory", path: root }] },
  } as unknown as OpencodeV2Client;
  const proof = (directory: string): V2NativeRuntimeProof => ({
    evidenceKind: "candidate",
    assertCurrent: () => currentV2RequestContext()?.permit.assertCurrent(),
    assertConfigRead: () => {},
    transport: scope.transport,
    generation: scope.generation,
    nativeVersion: "2.0.26",
    platform: "darwin",
    arch: "arm64",
    nativeContractDigest: "a".repeat(64),
    semanticProfile: "v2-global-config-v1",
    qualificationRecordId: "b".repeat(64),
    consumedApiDigest: "c".repeat(64),
    root,
    directory,
    consentRevision: scope.consentRevision,
    compatibilityDigest: app.artifact.compatibilityDigest,
  });
  const retire = vi.fn(async () => {}),
    participants = new Map<string, V2ActivationParticipant>([
      [
        "owned",
        {
          busyCount: () => 0,
          controlCount: () => 0,
          pauseRenewal: () => {},
          resumeRenewal: () => {},
          joinControl: async () => {},
          retire,
        },
      ],
    ]),
    close = vi.fn(async () => {});
  const jobs = new V2ActivationJobs(
    f.consent,
    async (job) => {
      const phase = job.phase;
      const proposal = {
        artifact: app.artifact,
        directories: new Set([root]),
        scope: { gate, participants },
      };
      await runV2ActivationTransaction(
        {
          ...job,
          phase: (state, reason) => {
            phase(state, reason);
            if (state === "waiting-for-idle") waiting.resolve();
          },
        },
        proposal,
        f.settings,
        f.consent,
        idle ?? ((signal) => readV2ActivationIdle(job, proposal, signal)),
        async (_artifact, _client, directory) => proof(directory),
      );
    },
    async () => ({ client, close, isRunning: () => true, onDeath: () => () => {} }),
  );
  return {
    app,
    client,
    root,
    scope,
    gate,
    jobs,
    waiting,
    retire,
    participants,
    close,
    proof,
    cleanup: async () => {
      await jobs.close();
      f.consent.close();
      await app.close();
    },
  };
}
