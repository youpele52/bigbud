import { expect, it } from "vitest";
import { ScopedGrantModel } from "./grant.model";
import { ControllerSettlementModel } from "./controller.model";
import { OwnerAuthExchange } from "./auth.model";
import { transcriptDigest, transcriptProof, finishAck } from "./auth";
import { hex, id, scopeFixture, scopedFixture } from "./test.fixture";

it("composes one-use proof consumption with lost finish/ack; no credential resurrection", () => {
  const fixture = scopedFixture();
  const grants = new ScopedGrantModel();
  grants.issue(fixture.hello.credentialId, fixture.key, fixture.expected.scope, 0, true, false);
  const exchange = new OwnerAuthExchange(
    fixture.hello,
    fixture.fields,
    fixture.key,
    fixture.expected,
    1,
  );
  const t = transcriptDigest(fixture.hello, fixture.fields);
  const finish = exchange.prove(
    {
      handshakeId: fixture.fields.handshakeId,
      transcript: t,
      clientProof: transcriptProof(fixture.key, "client-proof", t),
    },
    2,
    () => grants.consume(fixture.hello.credentialId, fixture.expected.scope, 2),
    () => {},
  );
  expect(() => grants.consume(fixture.hello.credentialId, fixture.expected.scope, 3)).toThrow(
    "GRANT_UNAVAILABLE",
  );
  exchange.acknowledge(finishAck(fixture.key, finish), 4, () => {});
  grants.installInitial(fixture.hello.credentialId, fixture.fields.proposedSession, true, false);
  expect(grants.isActive(2, fixture.hello.credentialId, fixture.fields.proposedSession)).toBe(true);
});

it("immutable scope replacement stays dormant until explicit CAS and fences old sessions", () => {
  const grants = new ScopedGrantModel();
  const scope = scopeFixture();
  grants.issue(id(12), id(13), scope, 0, true, false);
  grants.consume(id(12), scope, 1);
  grants.installInitial(id(12), id(14), true, false);
  const expanded = {
    ...scope,
    revision: "2",
    ptys: [...scope.ptys, { ...scope.ptys[0]!, ptyId: id(15) }],
  };
  grants.issue(id(16), id(17), expanded, 2, true, false);
  grants.prepareReplacement(2, id(14), id(16), true, false);
  expect(grants.isActive(2, id(12), id(14))).toBe(true);
  grants.consume(id(16), expanded, 3);
  grants.markDormant(2, id(16), id(18), 4);
  expect(grants.isActive(2, id(16), id(18))).toBe(false);
  expect(() => grants.commitReplacement(2, id(18), true, true, 5)).toThrow("REPLACEMENT_DENIED");
  grants.commitReplacement(2, id(18), true, false, 6);
  expect(grants.isActive(2, id(12), id(14))).toBe(false);
  expect(grants.isActive(2, id(16), id(18))).toBe(true);
  expect(() => grants.consume(id(12), scope, 7)).toThrow("GRANT_UNAVAILABLE");
});

it("checks original TTL, capability/role, bounded complete-scope accounting and failed preparation", () => {
  const grants = new ScopedGrantModel();
  const scope = scopeFixture();
  expect(() => grants.issue(id(12), id(13), scope, 0, false, false)).toThrow("ROLE_DENIED");
  expect(() => grants.issue(id(12), id(13), scopeFixture(4), 0, true, false)).toThrow(
    "ROLE_DENIED",
  );
  grants.issue(id(12), id(13), scope, 0, true, false);
  expect(() => grants.consume(id(12), { ...scope, createBudget: 31 }, 29999)).toThrow(
    "SCOPE_REVOKED",
  );
  expect(() => grants.consume(id(12), scope, 30000)).toThrow("GRANT_UNAVAILABLE");
  // Full scopes use their encoded size, never a constant pretending 126 scopes always fit.
  let capacity = false;
  for (let i = 20; i < 146; i++)
    try {
      grants.issue(id(i), id(13), scope, 0, true, false);
    } catch (error) {
      expect(String(error)).toContain("CAPACITY");
      capacity = true;
      break;
    }
  expect(capacity).toBe(true);
  expect(grants.snapshot().bytes).toBeLessThanOrEqual(65536);
});

it("controller replacement keeps accepted original work, no-replay floor and uncertainty stable", () => {
  const model = new ControllerSettlementModel();
  const work = hex(id(1));
  const digest = hex(id(2));
  model.admit(work, "1", digest, "1");
  const before = model.snapshot();
  expect(model.replace(hex(id(3)), "1", true, false)).toBe("2");
  expect(model.replace(hex(id(3)), "1", true, false)).toBe("2");
  expect(() => model.replace(hex(id(3)), "2", true, false)).toThrow("DIGEST_CONFLICT");
  expect(model.snapshot().records).toEqual(before.records);
  expect(model.admit(work, "1", digest, "2").controller).toBe("1");
  expect(() => model.admit(hex(id(4)), "2", hex(id(5)), "1")).toThrow("STALE_CONTROLLER");
  expect(() => model.activate("2", true, false, true)).toThrow("SETTLEMENT_PENDING");
  model.settle(work, digest, "succeeded");
  model.activate("2", true, false, true);
  model.compactThrough("1");
  expect(model.snapshot().floor).toBe("1");
  expect(() => model.admit(work, "1", digest, "2")).toThrow("EXPIRED_UNKNOWN");
  model.admit(hex(id(4)), "2", hex(id(5)), "2");
  model.settle(hex(id(4)), hex(id(5)), "partialUnknown");
  model.replace(hex(id(6)), "2", true, false);
  expect(() => model.activate("3", true, false, true)).toThrow("SETTLEMENT_PENDING");
  expect(() => model.compactThrough("2")).toThrow("SETTLEMENT_PENDING");
  expect(() => model.settle(hex(id(4)), hex(id(5)), "succeeded")).toThrow("OUTCOME_FENCED");
  expect(model.snapshot().highWater).toBe("2");
  expect(model.snapshot().floor).toBe("1");
});
