import { expect, it, vi } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import { V2EnrollmentRetirement } from "./Orchestration.enrollment.retirement.ts";
import { V2ActivationGate } from "./PluginSetup.activation.gate.ts";
import { readV2ActivationIdle } from "./PluginSetup.activation.activity.ts";
import type { V2OwnedActivationJob } from "./PluginSetup.activation.jobs.ts";

function activityFixture() {
  const active = vi.fn(async () => ({})),
    locations = vi.fn(async () => [{ directory: "/later-Location" }]),
    shells = vi.fn(async ({ location }: { location: { directory: string } }) => ({
      location,
      data: [],
    }));
  const job = {
    assertCurrent: () => {},
    signal: new AbortController().signal,
    connection: {
      client: {
        session: { active },
        debug: { location: { list: locations } },
        shell: { list: shells },
      },
    },
  } as unknown as V2OwnedActivationJob;
  return { job, active, locations, shells };
}

it("a setup waiter owns no reservation, but a real local reservation defers activity reads without cancelling work", async () => {
  const app = await makeV2ThreadPluginFixture(),
    f = activityFixture();
  try {
    const gate = new V2ActivationGate("synthetic-scope", "A", () => {}),
      proposal = {
        artifact: app.artifact,
        directories: new Set(["/A"]),
        scope: { gate, participants: new Map() },
      };
    expect(await readV2ActivationIdle(f.job, proposal)).toBe(true);
    expect(proposal.directories.has("/later-Location")).toBe(true);
    f.active.mockClear();
    const token = gate.tryReserve(gate.verify("/A", "A", "setup"), "real-start")!;
    expect(await readV2ActivationIdle(f.job, proposal)).toBe(false);
    expect(f.active).not.toHaveBeenCalled();
    expect(gate.busyCount()).toBe(1);
    gate.cancelUndispatched(token);
  } finally {
    await app.close();
  }
});

it.each(["active", "pending-initial", "pending-renewal", "revoked-expired"])(
  "a signed foreign %s owner is not idle or detached merely because its lease expired",
  async (state) => {
    const app = await makeV2ThreadPluginFixture(),
      f = activityFixture();
    try {
      const records = await V2ThreadRecords.open(
          app.artifact.root,
          "enrollments",
          app.artifact.privateKey,
          app.artifact.publicKey,
        ),
        owner = app.bind("foreign-native", "/foreign-Location"),
        signed = app.envelope("enroll", 1, Date.now() + 1000),
        digest = signed.ownerDigest,
        expired = { revision: 1, expiry: Date.now() - 1000 };
      await records.replace("foreign-record", undefined, {
        owner,
        digest,
        state:
          state === "revoked-expired"
            ? "revoked"
            : state === "pending-initial"
              ? "pending"
              : "active",
        acknowledged: state === "pending-initial" ? null : expired,
        pending:
          state === "pending-initial"
            ? expired
            : state === "pending-renewal"
              ? { revision: 2, expiry: Date.now() - 500 }
              : null,
      });
      const gate = new V2ActivationGate("synthetic-scope", "A", () => {}),
        proposal = {
          artifact: app.artifact,
          directories: new Set(["/A"]),
          scope: { gate, participants: new Map() },
        };
      const before = await records.entries();
      await expect(readV2ActivationIdle(f.job, proposal)).rejects.toThrow(
        "retained owner retirement",
      );
      expect(f.active).not.toHaveBeenCalled();
      expect(await records.entries()).toEqual(before);
      const retirement = await V2EnrollmentRetirement.open(records),
        identity = {
          wireProtocol: owner.protocol,
          ownerDigest: digest,
          enrollmentNonce: owner.enrollmentNonce,
          directory: owner.directory,
          nativeSessionId: owner.nativeSessionId,
        };
      await retirement.begin(identity, signed);
      const missing = {
        state: "missing" as const,
        ownerDigest: digest,
        enrollmentNonce: owner.enrollmentNonce,
        revision: 0,
        expiry: 0,
      };
      await retirement.acknowledge(
        identity,
        { ...missing, state: "revoked" },
        missing,
        app.artifact.artifactDigest,
        "synthetic-generation",
      );
      await expect(readV2ActivationIdle(f.job, proposal)).rejects.toThrow(
        "retained owner retirement",
      );
      await retirement.settle(identity, {
        physicalSettled: true,
        controlsSettled: true,
        callbacksSettled: true,
        creationSettled: true,
        admissionsSettled: true,
        receiptsSettled: true,
      });
      expect(await readV2ActivationIdle(f.job, proposal)).toBe(true);
      expect(f.active).toHaveBeenCalledTimes(1);
      expect(await records.entries()).toEqual(before);
    } finally {
      await app.close();
    }
  },
);
