import { ORGANIZATION_LIMITS, type OrganizationFrame } from "./organizationProtocol.ts";
import { fixtureRow } from "./organizationProtocol.fixtures.ts";
import { encodeCompactSnapshot } from "./organizationSnapshot.ts";

export function schedulingFixtureFrames(): OrganizationFrame[] {
  const epoch = { backendNonce: "scheduling-owner", generation: 1 };
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
    ...encodeCompactSnapshot(
      epoch,
      {
        snapshotId: "scheduling-snapshot",
        sequence: 1,
        sourceFrontier: 1,
        policy: {
          version: 1,
          fingerprint: "scheduling-policy",
          scheduling: {
            idleEnabled: false,
            idleTimeoutMs: 600000,
            idleDestination: 3,
            olderEnabled: false,
            olderTimeoutMs: 86400000,
            presentTarget: 7,
            targetNotBeforeMs: 0,
            graceMs: 300000,
          },
        },
      },
      [
        {
          ...fixtureRow,
          organizationRevision: 0,
          work: 2,
          inScope: true,
          manualAttentionWatermark: 0,
          engagedUntilMs: 0,
        },
      ],
    ),
  ];
}
