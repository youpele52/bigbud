import { Schema } from "effect";
import { expect, it } from "vitest";
import { ClientProof } from "./auth";
import { U64 } from "./primitives";

it("retains exact bigint-sized decimal counters and requires every proof field", () => {
  expect(Schema.decodeUnknownSync(U64)("18446744073709551615")).toBe("18446744073709551615");
  expect(() => Schema.decodeUnknownSync(U64)("18446744073709551616")).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(ClientProof)(
      { transcript: new Uint8Array(32), clientProof: new Uint8Array(32) },
      { onExcessProperty: "error" },
    ),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(ClientProof)(
      {
        handshakeId: new Uint8Array(32),
        transcript: new Uint8Array(32),
        clientProof: new Uint8Array(32),
        unknown: 1,
      },
      { onExcessProperty: "error" },
    ),
  ).toThrow();
});
