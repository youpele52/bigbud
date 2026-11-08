import { createHash } from "node:crypto";
import type { RawOrganizationFacts } from "./organizationFacts.query.ts";
import type { OrganizationRow } from "./organizationProtocol.ts";
import type { TerminalIdleWork } from "../terminal/Services/Manager.ts";

export interface OrganizationOwnerFacts {
  engagedUntilMs?: number;
  terminal: TerminalIdleWork;
  shell: "idle" | "active" | "unknown";
}
export function organizationAttentionIds(json: string): string[] {
  const ids: unknown = JSON.parse(json);
  if (
    !Array.isArray(ids) ||
    ids.length > 512 ||
    ids.some((id) => typeof id !== "string" || id.length > 512) ||
    Buffer.byteLength(json) > 32768
  )
    throw new Error("organisation attention facts exceed bounds");
  return ids as string[];
}
export function organizationTimestamp(value: string): number {
  const result = Date.parse(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error("invalid organisation timestamp");
  return result;
}
export function buildOrganizationFacts(
  raw: RawOrganizationFacts,
  owners: OrganizationOwnerFacts,
  nowMs: number,
  graceMs: number,
) {
  const sections: Record<string, number> = { "needs-you": 1, present: 2, later: 3, done: 4 };
  const section = sections[raw.section];
  if (!section) throw new Error("invalid organisation section");
  const attentionIds = organizationAttentionIds(raw.attentionIdsJson);
  if (raw.needsAttentionReminder === 1) attentionIds.push("snooze-reminder");
  const previousAttention = new Set(organizationAttentionIds(raw.attentionHistoryJson ?? "[]"));
  const newAttention = attentionIds.some((id) => !previousAttention.has(id));
  const attentionWatermark = (raw.attentionWatermark ?? 0) + (newAttention ? 1 : 0);
  if (!Number.isSafeInteger(attentionWatermark)) throw new Error("attention watermark exhausted");
  const work =
    raw.work === 2 || owners.terminal.state === "busy" || owners.shell === "active"
      ? 2
      : raw.work === 3 || owners.terminal.state === "unknown" || owners.shell === "unknown"
        ? 3
        : 1;
  const completed =
    raw.lastWorkState !== null && raw.lastWorkState !== "idle" && work === 1 ? nowMs : 0;
  const completionAt = Math.max(
    raw.lastWorkCompletedAtMs ?? 0,
    owners.terminal.quietSince ?? 0,
    completed,
    raw.workCompletedAt ? organizationTimestamp(raw.workCompletedAt) : 0,
  );
  const graceUntil = Math.max(
    raw.graceUntilMs ?? 0,
    completionAt === 0 ? 0 : completionAt + graceMs,
  );
  if (!Number.isSafeInteger(graceUntil)) throw new Error("organisation grace deadline overflow");
  const activityAt = Math.max(organizationTimestamp(raw.activityAt), completionAt);
  // A half-cleared snooze pair (restored/hand-edited row) is protected as an open-ended snooze:
  // never scheduled, never a malformed row that would make native admission resync forever.
  const snoozeDeadline =
    raw.snoozeUntil !== null ? organizationTimestamp(raw.snoozeUntil) : undefined;
  const snoozeIdentity = raw.snoozeIdentity ?? "";
  const snooze =
    (snoozeDeadline !== undefined) === (snoozeIdentity !== "")
      ? { identity: snoozeIdentity, until: snoozeDeadline }
      : { identity: snoozeIdentity || "inconsistent-snooze", until: Number.MAX_SAFE_INTEGER };
  const row: OrganizationRow = {
    threadId: raw.threadId,
    factVersion: raw.factVersion ?? 0,
    organizationRevision: raw.organizationRevision,
    section,
    work,
    actionable: raw.actionable !== 0 || raw.needsAttentionReminder === 1,
    attentionWatermark,
    ...(raw.agePending === 0 ? { inactivityAtMs: activityAt } : {}),
    ...(raw.manualUntilMs !== null ? { manualUntilMs: raw.manualUntilMs } : {}),
    ...(snooze.until !== undefined ? { snoozeUntilMs: snooze.until } : {}),
    snoozeIdentity: snooze.identity,
    ...(graceUntil > 0 ? { graceUntilMs: graceUntil } : {}),
    ...(owners.engagedUntilMs !== undefined ? { engagedUntilMs: owners.engagedUntilMs } : {}),
    eligible: raw.agePending === 0 && raw.deleted !== 1,
    inScope: raw.inScope !== 0 && raw.deleted !== 1,
    manualAttentionWatermark: raw.manualAttentionWatermark ?? 0,
    // Part of the digest, so clearing the identity (deliberate move) republishes the row.
    automaticPlacement: section === 1 && (raw.latestAutomaticMoveId ?? null) !== null,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify({ ...row, factVersion: 0, attentionIds }))
    .digest("hex");
  return {
    row,
    digest,
    completionAt,
    graceUntil,
    attentionIds,
    workState: work === 2 ? "active" : work === 3 ? "unknown" : "idle",
  };
}
