import { describe, expect, it } from "vitest";
import type { SessionFrameFields } from "@bigbud/contracts/terminal-owner/auth";
import {
  deriveRootAuthKey,
  recordDigest,
  transcriptDigest,
  transcriptProof,
  ownerFinish,
  finishFields,
  finishAck,
  sessionKeys,
  sessionFrameTag,
  verifySessionFrame,
  verifyTag,
  hmacSha256,
  validateAuthBinding,
} from "./auth";
import { OwnerAuthExchange } from "./auth.model";
import { hex, id, vectors, rootFixture, scopedFixture } from "./test.fixture";

function altered(value: unknown): unknown {
  if (value instanceof Uint8Array) return Uint8Array.from(value, (v, i) => (i === 0 ? v ^ 1 : v));
  if (typeof value === "string") return value === "0" ? "1" : "0";
  if (typeof value === "number") return value + 1;
  if (Array.isArray(value)) return value.slice(1);
  return Object.fromEntries(
    Object.entries(value as object).map(([k, v], i) => [k, i === 0 ? altered(v) : v]),
  );
}

function* fieldMutations(value: unknown, path = ""): Generator<[string, unknown]> {
  if (!value || typeof value !== "object" || value instanceof Uint8Array) {
    yield [path, altered(value)];
    return;
  }
  if (Array.isArray(value)) yield [path + ".count", value.slice(1)];
  for (const [key, child] of Object.entries(value)) {
    for (const [label, changed] of fieldMutations(child, `${path}.${key}`)) {
      yield [
        label,
        Object.assign(Array.isArray(value) ? value.slice() : {}, value, { [key]: changed }),
      ];
    }
  }
}

describe("terminal owner standard HMAC/transcript", () => {
  it("matches RFC 4231 and independent Python full exchange", () => {
    expect(
      hex(hmacSha256(new Uint8Array(20).fill(0x0b), new TextEncoder().encode("Hi There"))),
    ).toBe("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
    const { hello, fields, key } = rootFixture();
    expect(hex(recordDigest("ProfileIdentity", fields.profile))).toBe(
      vectors.expected.profileDigest,
    );
    expect(hex(recordDigest("Limits", fields.limits))).toBe(vectors.expected.limitsDigest);
    expect(
      hex(
        deriveRootAuthKey(id(10), hello.profileDigest, hello.ownerEpoch, hello.artifactSetDigest),
      ),
    ).toBe(vectors.expected.rootKey);
    const t = transcriptDigest(hello, fields);
    expect(hex(t)).toBe(vectors.expected.transcript);
    const finish = ownerFinish(key, finishFields(fields, t));
    expect(finish).toEqual(vectors.records.OwnerFinish);
    expect(finishAck(key, finish)).toEqual(vectors.records.FinishAck);
    const keys = sessionKeys(key, t, fields.proposedSession, fields.laneId);
    expect(hex(keys.clientToOwner)).toBe(vectors.expected.clientToOwner);
    expect(hex(keys.ownerToClient)).toBe(vectors.expected.ownerToClient);
    expect(
      hex(
        sessionFrameTag(
          keys.clientToOwner,
          vectors.records.SessionFrameFields as SessionFrameFields,
        ),
      ),
    ).toBe(vectors.expected.frameTag);
    expect(transcriptProof(key, "owner-proof", t)).not.toEqual(
      transcriptProof(key, "client-proof", t),
    );
    expect(verifyTag(id(1), new Uint8Array(31))).toBe(false);
  });
  it("binds every hello/challenge field into T or refuses malformed changes", () => {
    const { hello, fields } = rootFixture();
    const original = transcriptDigest(hello, fields);
    for (const part of ["hello", "fields"] as const)
      for (const [name, value] of Object.entries(part === "hello" ? hello : fields)) {
        let refused = false;
        let changed: Uint8Array | undefined;
        try {
          changed = transcriptDigest(
            part === "hello" ? { ...hello, [name]: altered(value) } : hello,
            part === "fields" ? { ...fields, [name]: altered(value) } : fields,
          );
        } catch {
          refused = true;
        }
        expect(refused || hex(changed!) !== hex(original), `${part}.${name}`).toBe(true);
      }
  });
  it("validates independently held profile, role, expected generation and peer facts", () => {
    const { hello, fields, expected } = rootFixture();
    validateAuthBinding(hello, fields, expected);
    for (const field of ["artifactSetDigest", "ownerEpoch", "endpointInstance"] as const)
      expect(() => validateAuthBinding(hello, fields, { ...expected, [field]: id(77) })).toThrow(
        "AUTH_FAILED",
      );
    expect(() =>
      validateAuthBinding(hello, fields, {
        ...expected,
        generations: { ...fields.generations, main: "1" },
      }),
    ).toThrow("AUTH_FAILED");
    expect(() =>
      validateAuthBinding(hello, fields, {
        ...expected,
        verifiedPeer: { ...expected.verifiedPeer, pid: "43" },
      }),
    ).toThrow("AUTH_FAILED");
    const scoped = scopedFixture();
    validateAuthBinding(scoped.hello, scoped.fields, scoped.expected);
    expect(() =>
      validateAuthBinding(scoped.hello, scoped.fields, {
        ...scoped.expected,
        scope: { ...scoped.expected.scope!, createBudget: 1 },
      }),
    ).toThrow("AUTH_FAILED");
  });
  it("binds every nested field of both root and scoped transcripts", () => {
    for (const fixture of [rootFixture(), scopedFixture()]) {
      const { hello, fields } = fixture;
      const original = hex(transcriptDigest(hello, fields));
      for (const part of ["hello", "fields"] as const) {
        for (const [label, changed] of fieldMutations(part === "hello" ? hello : fields)) {
          let refused = false;
          let changedDigest: string | undefined;
          try {
            changedDigest = hex(
              transcriptDigest(
                part === "hello" ? (changed as typeof hello) : hello,
                part === "fields" ? (changed as typeof fields) : fields,
              ),
            );
          } catch {
            refused = true;
          }
          expect(refused || changedDigest !== original, `${part}${label}`).toBe(true);
        }
      }
    }
  });
  it("fences header sequences, direction, scope and epoch before any receive advancement", () => {
    const frame = vectors.records.SessionFrameFields as SessionFrameFields;
    const tag = sessionFrameTag(id(1), frame);
    const { kind: _kind, body: _body, ...header } = frame;
    expect(verifySessionFrame(id(1), frame, tag, header)).toBe(true);
    expect(verifySessionFrame(id(1), frame, tag, { ...header, sequence: "1" })).toBe(false);
    expect(verifySessionFrame(id(1), frame, tag, { ...header, direction: 2 })).toBe(false);
    expect(verifySessionFrame(id(1), frame, tag, { ...header, scopeRevision: "1" })).toBe(false);
    expect(verifySessionFrame(id(1), { ...frame, body: id(22) }, tag, header)).toBe(false);
  });
});

describe("pure receiver exchange", () => {
  it.each([rootFixture, scopedFixture])(
    "requires proof then exact FinishAck; never acquires main",
    (fixture) => {
      const { hello, fields, key, expected } = fixture();
      const exchange = new OwnerAuthExchange(hello, fields, key, expected, 100);
      let consumed = 0;
      let rechecked = 0;
      const t = transcriptDigest(hello, fields);
      expect(() => exchange.acknowledge(vectors.records.FinishAck as never, 101, () => {})).toThrow(
        "AUTH_STATE",
      );
      const finish = exchange.prove(
        {
          handshakeId: fields.handshakeId,
          transcript: t,
          clientProof: transcriptProof(key, "client-proof", t),
        },
        102,
        () => {
          consumed++;
        },
        () => {},
      );
      expect(consumed).toBe(hello.kind === 1 ? 0 : 1);
      expect(exchange.state).toBe("finishPending");
      expect(() =>
        exchange.prove(
          {
            handshakeId: fields.handshakeId,
            transcript: t,
            clientProof: transcriptProof(key, "client-proof", t),
          },
          103,
          () => {
            consumed++;
          },
          () => {},
        ),
      ).toThrow("AUTH_STATE");
      const ack = finishAck(key, finish);
      expect(() =>
        exchange.acknowledge({ ...ack, ackProof: id(99) }, 104, () => {
          rechecked++;
        }),
      ).toThrow("AUTH_FAILED");
      expect(rechecked).toBe(0);
      expect(
        exchange.acknowledge(ack, 105, () => {
          rechecked++;
        }).disposition,
      ).toBe(hello.kind === 1 ? 1 : 3);
      expect(exchange.state).toBe("ready");
      expect(rechecked).toBe(1);
    },
  );
  it("expired, lost-finish and revoked-fence paths never reach ready or consume twice", () => {
    const { hello, fields, key, expected } = scopedFixture();
    const exchange = new OwnerAuthExchange(hello, fields, key, expected, 0);
    let consumed = 0;
    const t = transcriptDigest(hello, fields);
    const proof = {
      handshakeId: fields.handshakeId,
      transcript: t,
      clientProof: transcriptProof(key, "client-proof", t),
    };
    const finish = exchange.prove(
      proof,
      1,
      () => {
        consumed++;
      },
      () => {},
    );
    expect(() =>
      exchange.acknowledge(finishAck(key, finish), 2, () => {
        throw new Error("SCOPE_REVOKED");
      }),
    ).toThrow("SCOPE_REVOKED");
    expect(exchange.state).toBe("finishPending");
    expect(() => exchange.acknowledge(finishAck(key, finish), 5000, () => {})).toThrow(
      "AUTH_EXPIRED",
    );
    expect(exchange.state).toBe("closed");
    expect(consumed).toBe(1);
  });
});
