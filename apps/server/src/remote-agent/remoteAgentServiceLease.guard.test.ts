import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  encodeNativeLeaseGuardV2,
  type NativeLeaseGuardV2,
} from "./remoteAgentServiceLease.guard.ts";
function fixture(): { spec: NativeLeaseGuardV2; rawUtf8: string; guardSha256: string } {
  return JSON.parse(
    readFileSync(
      new URL(
        "../../../../protocol/remote-agent/service_lease.guard-v2.golden.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
}
it("encodes exact native guard-v2 bytes without circular self hashes", () => {
  const value = fixture(),
    bytes = encodeNativeLeaseGuardV2(value.spec);
  expect(Buffer.from(bytes).toString()).toBe(value.rawUtf8);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(value.guardSha256);
  expect(value.rawUtf8).toContain('"valueFrom":"configurationSha256"');
  expect(value.rawUtf8).not.toContain(value.guardSha256);
});
it("bounds total predicates, selected rows, private paths and unknown caller fields", () => {
  const value = fixture().spec;
  expect(() =>
    encodeNativeLeaseGuardV2({
      ...value,
      all: Array.from({ length: 32 }, () => ({ path: ["x"], values: [true] })),
    }),
  ).toThrow(/total predicate/);
  expect(() =>
    encodeNativeLeaseGuardV2({ ...value, select: [{ ...value.select[0]!, maxRows: 129 }] }),
  ).toThrow(/selected-array/);
  expect(() => encodeNativeLeaseGuardV2({ ...value, file: "/private/../unowned" })).toThrow(/path/);
  expect(() => encodeNativeLeaseGuardV2(Object.assign(value, { unexpected: true }))).toThrow(
    /fields/,
  );
});
