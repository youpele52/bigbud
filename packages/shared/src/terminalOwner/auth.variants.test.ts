import { expect, it } from "vitest";
import { OwnerAuthExchange } from "./auth.model";
import {
  transcriptDigest,
  transcriptProof,
  recordDigest,
  finishAck,
  validateAuthBinding,
} from "./auth";
import { ownerLimits } from "./limits";
import { rootFixture, scopedFixture, id } from "./test.fixture";

it("root status uses read-only intent and never consumes a grant", () => {
  const root = rootFixture();
  const intent = {
    ...root.hello.rootIntent!,
    mode: 5 as const,
    use: 3 as const,
    op: { sequence: "0", attemptId: id(0), expectedAuthorityRevision: "0" },
  };
  const hello = { ...root.hello, lane: 2 as const, rootIntent: intent };
  const limits = ownerLimits(1, true);
  const fields = {
    ...root.fields,
    lane: 2 as const,
    rootIntent: intent,
    limits,
    limitsDigest: recordDigest("Limits", limits),
  };
  const exchange = new OwnerAuthExchange(
    hello,
    fields,
    root.key,
    { ...root.expected, credential: { ...root.expected.credential, lane: 2 } },
    0,
  );
  const t = transcriptDigest(hello, fields);
  const finish = exchange.prove(
    {
      handshakeId: fields.handshakeId,
      transcript: t,
      clientProof: transcriptProof(root.key, "client-proof", t),
    },
    1,
    () => {
      throw new Error("must not consume");
    },
    () => {},
  );
  expect(exchange.acknowledge(finishAck(root.key, finish), 2, () => {}).disposition).toBe(2);
});

it("root lane ticket binds parent live identity, transcript and expected lane, without upgrade", () => {
  const root = rootFixture();
  const { rootIntent: _a, ...baseHello } = root.hello;
  const { rootIntent: _b, ...baseFields } = root.fields;
  const binding = {
    ticketId: id(16),
    serial: "1",
    ownerEpoch: id(1),
    endpointInstance: id(3),
    parentSession: id(17),
    parentTranscript: id(18),
    role: 1 as const,
    scopeDigest: id(0),
    scopeRevision: "0",
    generations: root.fields.generations,
    lane: 2 as const,
    ttlMs: "5000" as const,
  };
  const credential = {
    role: 1 as const,
    kind: 4 as const,
    credentialId: id(16),
    lane: 2 as const,
    laneBinding: binding,
  };
  const hello = { ...baseHello, ...credential };
  const fields = { ...baseFields, ...credential };
  const expected = {
    ...root.expected,
    credential,
    parent: {
      process: root.expected.verifiedPeer,
      session: id(17),
      transcript: id(18),
      statusOnly: false,
    },
  };
  validateAuthBinding(hello, fields, expected);
  expect(() =>
    validateAuthBinding(hello, fields, {
      ...expected,
      parent: { ...expected.parent, statusOnly: true },
    }),
  ).toThrow("AUTH_FAILED");
  expect(() =>
    validateAuthBinding(hello, fields, {
      ...expected,
      parent: { ...expected.parent, transcript: id(19) },
    }),
  ).toThrow("AUTH_FAILED");
  expect(() =>
    validateAuthBinding(hello, fields, { ...expected, credential: { ...credential, lane: 4 } }),
  ).toThrow("AUTH_FAILED");
  const exchange = new OwnerAuthExchange(hello, fields, root.key, expected, 0);
  let consumed = 0;
  const t = transcriptDigest(hello, fields);
  const proof = {
    handshakeId: fields.handshakeId,
    transcript: t,
    clientProof: transcriptProof(root.key, "client-proof", t),
  };
  expect(() =>
    exchange.prove(
      proof,
      1,
      () => {
        consumed++;
      },
      () => {
        throw new Error("PARENT_REVOKED");
      },
    ),
  ).toThrow("PARENT_REVOKED");
  expect(consumed).toBe(0);
  const finish = exchange.prove(
    proof,
    2,
    () => {
      consumed++;
    },
    () => {},
  );
  expect(exchange.acknowledge(finishAck(root.key, finish), 3, () => {}).disposition).toBe(5);
  expect(consumed).toBe(1);
});

it("scoped replacement binds owner-held old revision/session and remains dormant", () => {
  const scoped = scopedFixture();
  const replacement = {
    replacementId: id(20),
    oldGrantId: id(21),
    oldScopeRevision: "1",
    oldSession: id(22),
  };
  const scope = { ...scoped.fields.scope, revision: "2" };
  const credential = { ...scoped.expected.credential, kind: 3 as const, replacement };
  const hello = { ...scoped.hello, ...credential };
  const fields = {
    ...scoped.fields,
    ...credential,
    scope,
    scopeDigest: recordDigest("Scope", scope),
  };
  const expected = { ...scoped.expected, credential, scope };
  const exchange = new OwnerAuthExchange(hello, fields, scoped.key, expected, 0);
  const t = transcriptDigest(hello, fields);
  const finish = exchange.prove(
    {
      handshakeId: fields.handshakeId,
      transcript: t,
      clientProof: transcriptProof(scoped.key, "client-proof", t),
    },
    1,
    () => {},
    () => {},
  );
  expect(exchange.acknowledge(finishAck(scoped.key, finish), 2, () => {}).disposition).toBe(4);
  expect(() =>
    validateAuthBinding(hello, fields, {
      ...expected,
      credential: { ...credential, replacement: { ...replacement, oldSession: id(23) } },
    }),
  ).toThrow("AUTH_FAILED");
});
