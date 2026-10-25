import { describe, expect, it } from "vitest";
import type {
  CleanupGrantResult,
  ClientProof,
  OwnerFinish,
  FinishAck,
} from "@bigbud/contracts/terminal-owner/auth";
import type { LaneBinding } from "@bigbud/contracts/terminal-owner/identity";
import { CleanupGrantModel } from "./cleanupGrant.model";
import { OwnerAuthExchange } from "./auth.model";
import { recordDigest, transcriptDigest, transcriptProof, finishAck } from "./auth";
import { OwnerCleanupModel } from "./cleanup.model";
import { ownerPermission } from "./permissions";
import { ScopedGrantModel } from "./grant.model";
import { encodeCanonical } from "./canonical";
import { cleanupGrantFixture, cleanupAuthFixture } from "./cleanup.auth.fixture";
import { inventoryFixture, vectors, id, hex, scopeFixture } from "./test.fixture";

describe("prototype v1.1 immutable shutdown-inventory authentication", () => {
  it("matches independent Python cleanup grant, challenge, proof and finish known answers", () => {
    const inventory = inventoryFixture();
    const grant = structuredClone(vectors.records.CleanupGrantResult) as CleanupGrantResult;
    const fixture = cleanupAuthFixture(grant, inventory);
    const { hello, fields, expected, key } = fixture;
    const grants = new CleanupGrantModel(inventory);
    grants.issue(grant, 1, 0, 30000);
    const exchange = new OwnerAuthExchange(hello, fields, key, expected, 0);
    expect(hex(encodeCanonical("OwnerChallenge", exchange.challenge()))).toBe(
      vectors.canonical.CleanupOwnerChallenge,
    );
    expect(hex(transcriptDigest(hello, fields))).toBe(vectors.expected.cleanupTranscript);
    expect(hex(recordDigest("Scope", grant.scope))).toBe(vectors.expected.cleanupScopeDigest);
    const finish = exchange.prove(
      vectors.records.CleanupClientProof as ClientProof,
      1,
      () => grants.consume(grant.grantId, grant.scope, 1),
      () => {},
    );
    expect(finish).toEqual(vectors.records.CleanupOwnerFinish as OwnerFinish);
    exchange.acknowledge(vectors.records.CleanupFinishAck as FinishAck, 2, () =>
      grants.assertActive(grant.grantId, grant.scope, 2),
    );
    expect(exchange.state).toBe("ready");
    expect(() => grants.consume(grant.grantId, grant.scope, 3)).toThrow("GRANT_UNAVAILABLE");
  });

  it.each([33, 64])(
    "authenticates an actual owner-captured %i-PTY grant without widening ordinary scope",
    // Every PTY/permission revalidates canonical inventory: ~6s under root-suite load.
    // Use the saturation model's 15s test budget; credential deadlines stay unchanged.
    { timeout: 15_000 },
    (count) => {
      const model = new OwnerCleanupModel(id(1), id(230));
      for (let i = 0; i < count; i++) model.reserveResource("pty", id(11 + i), "live");
      model.begin({ sequence: "249", attemptId: id(2), expectedAuthorityRevision: "248" }, id(12));
      model.reserveAttempt(1, 0, true);
      const inventory = model.inventorySnapshot();
      const grant = cleanupGrantFixture(inventory);
      model.issueAttemptGrant(1, grant, 1);
      const { hello, fields, expected, key } = cleanupAuthFixture(grant, inventory);
      const grants = model.cleanupGrants();
      const exchange = new OwnerAuthExchange(hello, fields, key, expected, 1);
      const transcript = transcriptDigest(hello, fields);
      const proof = {
        handshakeId: fields.handshakeId,
        transcript,
        clientProof: transcriptProof(key, "client-proof", transcript),
      };
      const finish = exchange.prove(
        proof,
        2,
        () => grants.consume(grant.grantId, grant.scope, 2),
        () => {},
      );
      exchange.acknowledge(finishAck(key, finish), 3, () =>
        grants.assertActive(grant.grantId, grant.scope, 3),
      );
      expect(exchange.state).toBe("ready");
      expect(grant.scope.ptys).toHaveLength(0);
      const context = {
        role: 4,
        disposition: "active",
        use: 3,
        currentFences: true,
        quiescing: true,
        controllerActive: false,
        scope: grant.scope,
        shutdownInventory: inventory,
      } as const;
      for (const pty of inventory.ptys) {
        grants.authorizePty(grant.grantId, grant.scope, pty.ptyId, pty.terminalGeneration, 4);
        const target = {
          id: pty.ptyId,
          epoch: inventory.binding.ownerEpoch,
          generation: pty.terminalGeneration,
        };
        expect(ownerPermission(context, "status", target)).toBe(true);
        for (const op of [
          "spawn",
          "input",
          "resize",
          "close",
          "source",
          "checkpoint",
          "response",
          "issueGrant",
          "replaceController",
          "cleanup",
        ] as const)
          expect(ownerPermission(context, op, target)).toBe(false);
      }
      expect(ownerPermission(context, "domainSettlement")).toBe(true);
      expect(
        ownerPermission(context, "status", { id: id(11), epoch: id(99), generation: "1" }),
      ).toBe(false);
      expect(() => grants.authorizePty(grant.grantId, grant.scope, id(11), "2", 4)).toThrow(
        "INVENTORY_DENIED",
      );
      const ordinary = scopeFixture();
      const normal = {
        ...ordinary,
        ptys: Array.from({ length: count }, (_, i) => ({
          ...ordinary.ptys[0]!,
          ptyId: id(11 + i),
        })),
      };
      expect(() => new ScopedGrantModel().issue(id(40), id(46), normal, 0, true, false)).toThrow();
      const callerList = [...inventory.ptys];
      callerList.push({ ...inventory.ptys[0]!, slot: count, ptyId: id(200) });
      expect(callerList).toHaveLength(count + 1);
      expect(grants.inventorySnapshot().ptys).toHaveLength(count);
      expect(() => grants.authorizePty(grant.grantId, grant.scope, id(200), "1", 4)).toThrow(
        "INVENTORY_DENIED",
      );
      inventory.binding.inventoryId.fill(210);
      expect(() => grants.assertActive(grant.grantId, grant.scope, 4)).toThrow("SCOPE_REVOKED");
    },
  );

  it.each([
    "shutdownId",
    "inventoryCut",
    "ownerEpoch",
    "inventoryId",
    "parentRootSequence",
  ] as const)(
    "denies wrong %s even with internally consistent peer scope digest and proofs",
    (field) => {
      const inventory = inventoryFixture();
      const grant = cleanupGrantFixture(inventory);
      const binding = {
        ...grant.scope.cleanupInventory!,
        [field]: field === "parentRootSequence" ? "250" : id(201),
      };
      const scope = {
        ...grant.scope,
        cleanupInventory: binding,
        shutdownId: field === "shutdownId" ? binding.shutdownId : grant.scope.shutdownId,
        process:
          field === "ownerEpoch"
            ? { ...grant.scope.process, ownerEpoch: binding.ownerEpoch }
            : grant.scope.process,
      };
      const bad = { ...grant, scope, scopeDigest: recordDigest("Scope", scope) };
      const grants = new CleanupGrantModel(inventory);
      expect(() => grants.issue(bad, 1, 0, 30000)).toThrow("INVENTORY_DENIED");
      expect(grants.snapshot().grants).toBe(0);
      const { hello, fields, expected, key } = cleanupAuthFixture(bad, inventory);
      expect(() => new OwnerAuthExchange(hello, fields, key, expected, 0)).toThrow();
      expect(
        ownerPermission(
          {
            role: 4,
            disposition: "active",
            use: 3,
            currentFences: true,
            quiescing: true,
            controllerActive: false,
            scope: bad.scope,
            shutdownInventory: inventory,
          },
          "status",
        ),
      ).toBe(false);
    },
  );

  it("rejects widened and renewed cleanup credentials; rotation fences FinishAck", () => {
    const inventory = inventoryFixture();
    const grant = cleanupGrantFixture(inventory);
    const grants = new CleanupGrantModel(inventory);
    grants.issue(grant, 1, 0, 30000);
    const changed = { ...structuredClone(grant), grantId: id(210) };
    expect(() => grants.issue(changed, 1, 2, 30000)).toThrow("CAPACITY");
    expect(() =>
      new ScopedGrantModel().issue(grant.grantId, grant.secret, grant.scope, 0, true, true),
    ).toThrow("ROLE_DENIED");
    const widened = { ...grant.scope, ptys: scopeFixture().ptys };
    expect(() => grants.consume(grant.grantId, widened, 1)).toThrow();
    const { hello, fields, expected, key } = cleanupAuthFixture(grant, inventory);
    const exchange = new OwnerAuthExchange(hello, fields, key, expected, 0);
    const transcript = transcriptDigest(hello, fields);
    const finish = exchange.prove(
      {
        handshakeId: fields.handshakeId,
        transcript,
        clientProof: transcriptProof(key, "client-proof", transcript),
      },
      1,
      () => grants.consume(grant.grantId, grant.scope, 1),
      () => {},
    );
    grants.revoke(grant.grantId);
    expect(() =>
      exchange.acknowledge(finishAck(key, finish), 2, () =>
        grants.assertActive(grant.grantId, grant.scope, 2),
      ),
    ).toThrow("SCOPE_REVOKED");
    expect(exchange.state).not.toBe("ready");
    expect(() => grants.consume(grant.grantId, grant.scope, 3)).toThrow("GRANT_UNAVAILABLE");
  });
  it("binds single-use status tickets to installed parent, original scope and rotation fences", () => {
    const inventory = inventoryFixture();
    const grant = cleanupGrantFixture(inventory);
    const grants = new CleanupGrantModel(inventory);
    grants.issue(grant, 1, 0, 30000);
    grants.consume(grant.grantId, grant.scope, 1);
    grants.installSession(grant.grantId, grant.scope, id(44), id(47), id(3), 2);
    const binding: LaneBinding = {
      ticketId: id(90),
      serial: "1",
      ttlMs: "5000",
      parentSession: id(44),
      parentTranscript: id(47),
      role: 4,
      lane: 2,
      ownerEpoch: inventory.binding.ownerEpoch,
      endpointInstance: id(3),
      scopeRevision: "1",
      scopeDigest: grant.scopeDigest,
      generations: grant.scope.generations,
    };
    grants.issueStatusTicket(grant.grantId, grant.scope, binding, 3);
    for (const changed of [
      { ...binding, parentSession: id(48) },
      { ...binding, scopeRevision: "2" },
      { ...binding, generations: { ...binding.generations, controller: "2" } },
      { ...binding, endpointInstance: id(49) },
    ])
      expect(() => grants.consumeStatusTicket(grant.grantId, grant.scope, changed, 4)).toThrow();
    grants.consumeStatusTicket(grant.grantId, grant.scope, binding, 4);
    expect(() => grants.consumeStatusTicket(grant.grantId, grant.scope, binding, 5)).toThrow(
      "GRANT_UNAVAILABLE",
    );
    const second = { ...binding, ticketId: id(91), serial: "2" };
    grants.issueStatusTicket(grant.grantId, grant.scope, second, 5);
    expect(() => grants.consumeStatusTicket(grant.grantId, grant.scope, second, 5005)).toThrow(
      "GRANT_UNAVAILABLE",
    );
    grants.revoke(grant.grantId);
    expect(() => grants.consumeStatusTicket(grant.grantId, grant.scope, second, 6)).toThrow(
      "SCOPE_REVOKED",
    );
  });
  it("authenticates a status-only cleanup lane once and rejects replacement/minor0 downgrade", () => {
    const inventory = inventoryFixture();
    const grant = cleanupGrantFixture(inventory);
    const grants = new CleanupGrantModel(inventory);
    grants.issue(grant, 1, 0, 30000);
    grants.consume(grant.grantId, grant.scope, 1);
    grants.installSession(grant.grantId, grant.scope, id(44), id(47), id(3), 2);
    const binding: LaneBinding = {
      ticketId: id(90),
      serial: "1",
      ttlMs: "5000",
      parentSession: id(44),
      parentTranscript: id(47),
      role: 4,
      lane: 2,
      ownerEpoch: inventory.binding.ownerEpoch,
      endpointInstance: id(3),
      scopeRevision: "1",
      scopeDigest: grant.scopeDigest,
      generations: grant.scope.generations,
    };
    grants.issueStatusTicket(grant.grantId, grant.scope, binding, 3);
    const base = cleanupAuthFixture(grant, inventory);
    const credential = {
      kind: 4 as const,
      role: 4 as const,
      lane: 2 as const,
      credentialId: binding.ticketId,
      laneBinding: binding,
    };
    const hello = { ...base.hello, ...credential };
    const fields = { ...base.fields, ...credential };
    const expected = {
      ...base.expected,
      credential,
      parent: {
        process: grant.scope.process,
        session: binding.parentSession,
        transcript: binding.parentTranscript,
        statusOnly: false,
      },
    };
    const key = id(91);
    const exchange = new OwnerAuthExchange(hello, fields, key, expected, 3);
    const transcript = transcriptDigest(hello, fields);
    const finish = exchange.prove(
      {
        handshakeId: fields.handshakeId,
        transcript,
        clientProof: transcriptProof(key, "client-proof", transcript),
      },
      4,
      () => grants.consumeStatusTicket(grant.grantId, grant.scope, binding, 4),
      () => grants.assertActive(grant.grantId, grant.scope, 4),
    );
    expect(
      exchange.acknowledge(finishAck(key, finish), 5, () =>
        grants.assertActive(grant.grantId, grant.scope, 5),
      ).disposition,
    ).toBe(5);
    expect(() => grants.consumeStatusTicket(grant.grantId, grant.scope, binding, 6)).toThrow(
      "GRANT_UNAVAILABLE",
    );
    const replacement = {
      replacementId: id(92),
      oldGrantId: grant.grantId,
      oldScopeRevision: "1",
      oldSession: id(44),
    };
    expect(
      () =>
        new OwnerAuthExchange(
          { ...base.hello, kind: 3, replacement },
          { ...base.fields, kind: 3, replacement },
          grant.secret,
          base.expected,
          3,
        ),
    ).toThrow("AUTH_ROLE");
    expect(
      () =>
        new OwnerAuthExchange(
          { ...base.hello, minorMin: 0, minorMax: 0 },
          { ...base.fields, minor: 0 },
          grant.secret,
          base.expected,
          3,
        ),
    ).toThrow("AUTH_VERSION");
  });
});
