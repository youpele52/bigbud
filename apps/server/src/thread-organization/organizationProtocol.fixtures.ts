import {
  ORGANIZATION_LIMITS,
  type OrganizationFrame,
  type OrganizationRow,
} from "./organizationProtocol.ts";
import { encodeCompactSnapshot } from "./organizationSnapshot.ts";

export const fixtureRow: OrganizationRow = {
  threadId: "thread-a",
  factVersion: 1,
  organizationRevision: 4,
  section: 3,
  work: 3,
  actionable: false,
  attentionWatermark: 0,
  inactivityAtMs: 0,
  snoozeIdentity: "",
  eligible: true,
};
export function fixtureFrames(): OrganizationFrame[] {
  const epoch = { backendNonce: "backend", generation: 7 };
  const snapshot = [
    ...encodeCompactSnapshot(
      epoch,
      {
        snapshotId: "snapshot",
        sequence: 10,
        sourceFrontier: 100,
        policy: { version: 2, fingerprint: "policy", olderPolicyChangedAtMs: 0 },
      },
      [fixtureRow],
    ),
  ];
  const attention = {
    ...fixtureRow,
    factVersion: 2,
    section: 1,
    work: 2,
    actionable: true,
    attentionWatermark: 101,
    snoozeUntilMs: 600_000,
    snoozeIdentity: "snooze-1",
    graceUntilMs: 300_000,
  };
  const fact: OrganizationFrame = {
    ...epoch,
    type: "fact",
    value: { sequence: 11, sourceFrontier: 101, row: attention, deleted: false },
  };
  return [
    {
      ...epoch,
      type: "hello",
      value: {
        major: 1,
        minor: 0,
        capability: "compact-facts-v1",
        limits: { ...ORGANIZATION_LIMITS },
      },
    },
    ...snapshot.slice(0, -1),
    fact,
    snapshot.at(-1)!,
    {
      ...epoch,
      type: "fact",
      value: {
        sequence: 12,
        sourceFrontier: 102,
        row: { ...attention, factVersion: 3, manualUntilMs: 700_000 },
        deleted: false,
      },
    },
    {
      ...epoch,
      type: "fact",
      value: {
        sequence: 13,
        sourceFrontier: 103,
        row: { ...fixtureRow, factVersion: 4, attentionWatermark: 101 },
        deleted: true,
      },
    },
    fact,
  ];
}
