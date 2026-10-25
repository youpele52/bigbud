import { describe, expect, it } from "vitest";
import { OwnerAuthorityModel } from "./authority.model";
import { OrphanLeaseModel } from "./lease.model";
import { recordDigest } from "./auth";
import { id, rootFixture, vectors } from "./test.fixture";

describe("pure root authority CAS and terminal lost-response outcomes", () => {
  it.each([false, true])(
    "never rolls admission high-water back or rebinds a reserved sequence, B-first=%s",
    (bFirst) => {
      const model = new OwnerAuthorityModel();
      const a = rootFixture().hello.rootIntent!;
      const b = { ...a, op: { ...a.op, sequence: "2", attemptId: id(21) } };
      model.authenticated(id(8), a, 0);
      model.authenticated(id(9), b, 0);
      const winner = bFirst ? b : a;
      const winnerSession = id(bFirst ? 9 : 8);
      model.commit(winnerSession, winner, 1, false);
      expect(model.status().highWater).toBe("2");
      expect(() =>
        model.authenticated(id(10), { ...b, op: { ...b.op, attemptId: id(22) } }, 2),
      ).toThrow("CAS_CONFLICT");
      const c = {
        ...a,
        op: { sequence: "3", attemptId: id(23), expectedAuthorityRevision: "1" },
        expectedMainGeneration: "1",
        expectedMainSession: winnerSession,
      };
      model.authenticated(id(10), c, 2);
      const committed = model.commit(id(10), c, 3, true);
      model.disconnect(id(bFirst ? 8 : 9), 4);
      const loser = bFirst ? a : b;
      expect(
        model.query(loser.op.sequence, loser.op.attemptId, recordDigest("RootIntent", loser)).state,
      ).toBe("notCommitted");
      expect(model.query("3", c.op.attemptId, recordDigest("RootIntent", c)).outcome).toEqual(
        committed,
      );
      expect(
        model.query(winner.op.sequence, winner.op.attemptId, recordDigest("RootIntent", winner))
          .state,
      ).toBe("committed");
      expect(model.status().highWater).toBe("3");
      expect(() => model.commit(id(bFirst ? 8 : 9), loser, 5, true)).toThrow();
      model.expireCandidates(5000);
      expect(model.query("3", c.op.attemptId, recordDigest("RootIntent", c)).outcome).toEqual(
        committed,
      );
    },
  );
  it("proof/candidate/status do not acquire; commit once and resume keeps generation", () => {
    const model = new OwnerAuthorityModel();
    const intent = rootFixture().hello.rootIntent!;
    expect(model.authenticated(id(8), intent, 0)).toBe("candidate");
    expect(model.status().generation).toBe("0");
    expect(model.query("1", intent.op.attemptId, recordDigest("RootIntent", intent)).state).toBe(
      "pending",
    );
    const committed = model.commit(id(8), intent, 1, false);
    expect(committed.generation).toBe("1");
    expect(committed.digest).toBe(vectors.expected.rootMutation);
    expect(model.commit(id(8), intent, 2, false)).toEqual(committed);
    expect(model.query("1", intent.op.attemptId, recordDigest("RootIntent", intent)).state).toBe(
      "committed",
    );
    model.disconnect(id(8), 3);
    const status = {
      ...intent,
      mode: 5 as const,
      use: 3 as const,
      op: { sequence: "0", attemptId: id(0), expectedAuthorityRevision: "0" },
    };
    const before = model.status();
    expect(model.authenticated(id(9), status, 4)).toBe("statusOnly");
    expect(model.status()).toEqual(before);
    expect(() => model.commit(id(9), status, 4, false)).toThrow();
    const resume = {
      ...intent,
      mode: 2 as const,
      op: { sequence: "2", attemptId: id(10), expectedAuthorityRevision: "1" },
      expectedMainGeneration: "1",
      expectedMainSession: id(8),
    };
    model.authenticated(id(9), resume, 5);
    expect(model.commit(id(9), resume, 6, false).generation).toBe("1");
    expect(model.lease.remaining(7)).toBe(0);
    expect(model.status().highWater).toBe("2");
    expect(model.status().floor).toBe("0");
  });
  it("live pending stays pending; retirement is terminal, late/rebound commit fenced", () => {
    const model = new OwnerAuthorityModel();
    const intent = rootFixture().hello.rootIntent!;
    expect(model.query("1", intent.op.attemptId, recordDigest("RootIntent", intent)).state).toBe(
      "unknown",
    );
    model.authenticated(id(8), intent, 0);
    expect(model.query("1", intent.op.attemptId, recordDigest("RootIntent", intent)).state).toBe(
      "pending",
    );
    model.expireCandidates(5000);
    expect(model.query("1", intent.op.attemptId, recordDigest("RootIntent", intent)).state).toBe(
      "notCommitted",
    );
    expect(model.query("1", intent.op.attemptId, id(99)).state).toBe("unknown");
    expect(() => model.commit(id(8), intent, 5001, false)).toThrow();
    expect(() => model.authenticated(id(9), intent, 5002)).toThrow("CAS_CONFLICT");
    expect(model.status().generation).toBe("0");
  });
  it("rotation retains generation; handover increments once; stale incumbent cannot commit", () => {
    const model = new OwnerAuthorityModel();
    const intent = rootFixture().hello.rootIntent!;
    model.authenticated(id(8), intent, 0);
    model.commit(id(8), intent, 1, false);
    const rotate = {
      ...intent,
      mode: 3 as const,
      op: { sequence: "2", attemptId: id(10), expectedAuthorityRevision: "1" },
      expectedMainGeneration: "1",
      expectedMainSession: id(8),
    };
    model.authenticated(id(9), rotate, 2);
    expect(model.commit(id(9), rotate, 3, false).generation).toBe("1");
    const replacement = { ...intent.subject, pid: "43" };
    expect(() => model.prepareHandover(id(8), id(12), replacement, 1, 4)).toThrow("ROLE_DENIED");
    model.prepareHandover(id(9), id(12), replacement, 1, 4);
    const handover = {
      ...rotate,
      mode: 4 as const,
      op: { sequence: "3", attemptId: id(13), expectedAuthorityRevision: "2" },
      subject: replacement,
      expectedMainSession: id(9),
      handoverTicket: id(12),
    };
    model.authenticated(id(14), handover, 5);
    expect(model.commit(id(14), handover, 6, false).generation).toBe("2");
    expect(model.commit(id(14), handover, 7, false).generation).toBe("2");
  });
  it("expiry wins at boundary; cleanup reattach cannot resurrect ordinary authority", () => {
    const model = new OwnerAuthorityModel();
    const intent = rootFixture().hello.rootIntent!;
    model.authenticated(id(8), intent, 0);
    model.commit(id(8), intent, 1, false);
    model.disconnect(id(8), 2);
    const resume = {
      ...intent,
      mode: 2 as const,
      op: { sequence: "2", attemptId: id(10), expectedAuthorityRevision: "1" },
      expectedMainGeneration: "1",
      expectedMainSession: id(8),
    };
    model.authenticated(id(9), resume, 300001);
    expect(() => model.commit(id(9), resume, 300002, false)).toThrow("QUIESCING");
    model.disconnect(id(9), 300003);
    const cleanup = {
      ...resume,
      use: 2 as const,
      op: { sequence: "3", attemptId: id(11), expectedAuthorityRevision: "1" },
    };
    model.authenticated(id(12), cleanup, 300004);
    model.commit(id(12), cleanup, 300005, false);
    expect(model.status().quiescing).toBe(true);
    expect(model.lease.expired).toBe(true);
  });
});

describe("awake receiver lease", () => {
  it("does not count suspend or repeated observations; expiry is permanent", () => {
    const lease = new OrphanLeaseModel();
    lease.orphan(100);
    expect(lease.remaining(200)).toBe(299900);
    // One day of OS suspend: receiver awake clock stays at 200.
    expect(lease.remaining(200)).toBe(299900);
    lease.orphan(201);
    expect(lease.remaining(300099)).toBe(1);
    expect(() => lease.commitOrdinaryReattach(300100)).toThrow("LEASE_EXPIRED");
    expect(() => lease.commitOrdinaryReattach(300101)).toThrow("LEASE_EXPIRED");
    expect(() => lease.sample(299999)).toThrow("CLOCK_INVALID");
  });
});
