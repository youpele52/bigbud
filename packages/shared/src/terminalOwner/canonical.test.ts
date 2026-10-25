import { describe, expect, it } from "vitest";
import { encodeCanonical, canonicalDomain, type CanonicalRecord } from "./canonical";
import { vectors, hex, id, rootFixture, scopeFixture } from "./test.fixture";

describe("terminal owner typed C", () => {
  it("refuses accessor/custom-iterator/prototype arrays before any supplied code executes", () => {
    const scope = scopeFixture();
    let invoked = 0;
    const getter = [1, 9];
    Object.defineProperty(getter, "0", {
      get() {
        invoked++;
        return 1;
      },
    });
    const iterator = [1, 9];
    Object.defineProperty(iterator, Symbol.iterator, {
      get() {
        invoked++;
        return function* () {
          invoked++;
          yield 1;
        };
      },
    });
    const prototype = [1, 9];
    Object.setPrototypeOf(prototype, {
      [Symbol.iterator]() {
        invoked++;
        return [1][Symbol.iterator]();
      },
    });
    for (const capabilities of [getter, iterator, prototype]) {
      expect(() => encodeCanonical("Scope", { ...scope, capabilities })).toThrow();
      expect(invoked).toBe(0);
    }
    const entries = [...scope.ptys];
    Object.defineProperty(entries, "0", {
      get() {
        invoked++;
        return scope.ptys[0];
      },
    });
    expect(() => encodeCanonical("Scope", { ...scope, ptys: entries })).toThrow();
    expect(invoked).toBe(0);
  });
  for (const [name, input] of Object.entries(vectors.records))
    it(`matches independent Python ${name}`, () => {
      expect(hex(encodeCanonical(vectors.types[name] as CanonicalRecord, input))).toBe(
        vectors.canonical[name],
      );
      const reversed = Object.fromEntries(Object.entries(input as object).toReversed());
      expect(hex(encodeCanonical(vectors.types[name] as CanonicalRecord, reversed))).toBe(
        vectors.canonical[name],
      );
    });
  it("is strict UTF-8, without normalization", () => {
    expect(hex(canonicalDomain("é"))).toBe("00000002c3a9");
    expect(canonicalDomain("é")).not.toEqual(canonicalDomain("e\u0301"));
    expect(() => canonicalDomain("\ud800")).toThrow("CANONICAL_UTF8");
  });
  it("refuses unknown fields, missing defaults, optional undefined, accessors and symbols", () => {
    const { hello } = rootFixture();
    expect(() => encodeCanonical("ClientHello", { ...hello, extension: 0 })).toThrow(
      "CANONICAL_FIELDS",
    );
    const { minorMin: _minor, ...missing } = hello;
    expect(() => encodeCanonical("ClientHello", missing)).toThrow("CANONICAL_PRESENCE");
    expect(() => encodeCanonical("ClientHello", { ...hello, replacement: undefined })).toThrow();
    let called = false;
    const getter = {
      ...hello,
      get minorMin() {
        called = true;
        return 0;
      },
    };
    expect(() => encodeCanonical("ClientHello", getter)).toThrow("CANONICAL_ACCESSOR");
    expect(called).toBe(false);
    expect(() => encodeCanonical("ClientHello", { ...hello, [Symbol("hidden")]: 1 })).toThrow();
  });
  it.each(["01", "-1", "1.0", "18446744073709551616", "1e2", " ", 1])(
    "does not coerce invalid u64 %s",
    (sequence) => {
      expect(() =>
        encodeCanonical("RootOp", { sequence, attemptId: id(1), expectedAuthorityRevision: "0" }),
      ).toThrow();
    },
  );
  it("checks encoded bounds before output allocation and rejects shared bytes", () => {
    const frame = vectors.records.SessionFrameFields as object;
    expect(() =>
      encodeCanonical("SessionFrameFields", { ...frame, body: new Uint8Array(49153) }),
    ).toThrow();
    expect(() =>
      encodeCanonical("SessionFrameFields", {
        ...frame,
        body: new Uint8Array(new SharedArrayBuffer(4)),
      }),
    ).toThrow();
    expect(() =>
      encodeCanonical("Scope", { ...scopeFixture(), ptys: Array(65).fill(scopeFixture().ptys[0]) }),
    ).toThrow("CANONICAL_ARRAY");
  });
  it("checks roles, sorted scope, birth tags, required limits and unused identities", () => {
    const { hello, fields } = rootFixture();
    expect(() => encodeCanonical("ClientHello", { ...hello, role: 0 })).toThrow();
    expect(() => encodeCanonical("Scope", { ...scopeFixture(), capabilities: [9, 1] })).toThrow(
      "SCOPE_INVALID",
    );
    expect(() => encodeCanonical("Scope", { ...scopeFixture(3), capabilities: [1] })).toThrow(
      "SCOPE_INVALID",
    );
    expect(() =>
      encodeCanonical("Scope", {
        ...scopeFixture(),
        ptys: [scopeFixture().ptys[0], scopeFixture().ptys[0]],
      }),
    ).toThrow("SCOPE_ORDER");
    expect(() =>
      encodeCanonical("ProcessIdentity", {
        ...hello.rootIntent!.subject,
        birth: Uint8Array.of(3, ...new Uint8Array(8)),
      }),
    ).toThrow("PROCESS_IDENTITY_INVALID");
    expect(() =>
      encodeCanonical("ChallengeFields", {
        ...fields,
        limits: { entries: fields.limits.entries.slice(1) },
      }),
    ).toThrow();
    expect(() => encodeCanonical("RootIntent", { ...hello.rootIntent, mode: 5, use: 1 })).toThrow(
      "ROOT_INTENT_INVALID",
    );
  });
});
