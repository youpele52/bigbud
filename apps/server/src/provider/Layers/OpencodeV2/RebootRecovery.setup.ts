import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { randomBytes } from "node:crypto";
import { applyV2RebootRecovery } from "./RebootRecovery.ts";
import { readV2RebootCheckpoint, readV2RebootProof } from "./RebootRecovery.proof.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import { recoveryAdmissionQuery, recoveryBindingQuery } from "./RebootRecovery.evidence.ts";
import { readV2NativeActivity } from "./PluginSetup.activity.ts";
import { currentV2RequestContext } from "./Client.guard.ts";
import type { V2ThreadToolsActivation } from "./PluginSetup.activation.ts";
import type { V2PluginSetupArtifact } from "./PluginSetup.record.ts";
import type { V2ActivationJobScope } from "./PluginSetup.activation.jobs.ts";
import type { OpencodeV2Client } from "./Client.ts";

/** Called only by explicit consent-gated setup, before normal managed publication. No native mutation. */
export async function recoverV2RebootForSetup(input: {
  artifact: V2PluginSetupArtifact;
  activation: V2ThreadToolsActivation;
  descriptor: V2ActivationJobScope["descriptor"];
  client: OpencodeV2Client;
  sql: SqlClient.SqlClient | undefined;
  signal: AbortSignal;
}) {
  const records = await V2ThreadRecords.open(
    input.artifact.root,
    "enrollments",
    input.artifact.privateKey,
    input.artifact.publicKey,
  );
  if (!(await readV2RebootCheckpoint(records)) || (await readV2RebootProof(records))) return;
  const sql = input.sql,
    context = currentV2RequestContext();
  if (!sql || context?.intent !== "execute" || !context.permit.assertNativeConfigRead)
    throw new Error(
      "V2 reboot recovery requires current expanded setup consent and the authoritative journal.",
    );
  context.permit.assertNativeConfigRead();
  const scope = input.activation.scopeFor(input.artifact, input.descriptor);
  const job = `reboot:${randomBytes(16).toString("hex")}`;
  if (scope.participants.size || !scope.gate.tryCloseGate(job))
    throw new Error("V2 reboot recovery found live local ownership; no recovery writes.");
  const assertCurrent = () => {
    input.signal.throwIfAborted();
    context.permit.assertCurrent();
    context.permit.assertNativeConfigRead!();
    scope.gate.assertGate(job);
    if (scope.participants.size) throw new Error("V2 reboot recovery owner appeared.");
  };
  try {
    await applyV2RebootRecovery({
      enrollments: records,
      assertCurrent,
      signal: input.signal,
      readJournal: async (threadId) => ({
        admissions: await Effect.runPromise(
          sql.unsafe<Record<string, unknown>>(recoveryAdmissionQuery, [threadId]),
        ),
        bindings: await Effect.runPromise(
          sql.unsafe<Record<string, unknown>>(recoveryBindingQuery, [threadId]),
        ),
      }),
      assertIdle: async () => {
        const activity = await readV2NativeActivity(input.client, assertCurrent, input.signal);
        if (activity.foregroundCount || activity.runningShellCount)
          throw new Error(
            "V2 reboot recovery requires known native work to settle; it never interrupts it.",
          );
      },
    });
  } finally {
    scope.gate.releaseGate(job);
  }
}
