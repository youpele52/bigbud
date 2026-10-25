import { describe, expect, it } from "vitest";
import { decodeProcessIdentity } from "./ownershipRecovery.identity";

// Shared with the Rust process_identity golden test: v1, pid 42, /x, argv [/x], same user.
const golden = "0801102a1a022f7822022f782801";
describe("native identity codec", () => {
  it("decodes the Rust golden response", () => {
    expect(decodeProcessIdentity(Buffer.from(golden, "hex"))).toEqual({
      pid: 42,
      executable: "/x",
      arguments: ["/x"],
    });
  });
  it.each(["0802" + golden.slice(4), golden.slice(0, -4), golden + "0801", golden.slice(0, -1)])(
    "rejects incompatible, unowned, duplicate and truncated frames",
    (hex) => {
      expect(() => decodeProcessIdentity(Buffer.from(hex, "hex"))).toThrow();
    },
  );
  it("rejects oversized frames", () => {
    expect(() => decodeProcessIdentity(new Uint8Array(16385))).toThrow();
  });
});
