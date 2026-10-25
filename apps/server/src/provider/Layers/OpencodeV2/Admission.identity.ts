import { createHash } from "node:crypto";

import { MessageId, ThreadId, TurnId } from "@bigbud/contracts/core/baseSchemas";
import type { ProviderTurnAdmissionIdentity } from "@bigbud/contracts/orchestration/providerTurnAdmission.ts";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Job identity, never input text or a per-attempt UUID, owns the review namespace. */
export function learningAdmissionIdentity(ownerThreadId: ThreadId, jobId: string) {
  if (!jobId.trim()) throw new Error("Learning admission requires a durable job ID.");
  const id = digest(["opencodeV2", "learning", ownerThreadId, jobId]);
  return {
    identity: {
      namespace: "learning",
      ownerThreadId,
      requestMessageId: MessageId.makeUnsafe(`learning-v2-${id}`),
    } satisfies ProviderTurnAdmissionIdentity,
    threadId: ThreadId.makeUnsafe(`learning-v2-${id}`),
  };
}

/** Pure stable mapping; native msg_ format is pinned-source evidence, not execution idempotency proof. */
export function admissionCorrelation(identity: ProviderTurnAdmissionIdentity) {
  const id = digest([
    "opencodeV2",
    identity.namespace,
    identity.ownerThreadId,
    identity.requestMessageId,
  ]);
  return { nativeAdmissionId: `msg_bigbud_${id}`, turnId: TurnId.makeUnsafe(`opencode-v2-${id}`) };
}

/** Detect immutable material conflicts; this digest never provides request identity. */
export function admissionFingerprint(material: {
  readonly text: string;
  readonly model: { readonly providerID: string; readonly id: string; readonly variant?: string };
  readonly policy: "untrusted-read-only" | "synthetic-no-execution";
}): string {
  return digest([
    material.text,
    material.model.providerID,
    material.model.id,
    material.model.variant ?? null,
    material.policy,
  ]);
}

export function isDurableLearningThread(threadId: ThreadId): boolean {
  return /^learning-v2-[a-f0-9]{64}$/.test(threadId);
}
