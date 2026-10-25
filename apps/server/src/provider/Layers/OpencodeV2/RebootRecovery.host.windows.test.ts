import { expect, it } from "vitest";
import { decodeV2WindowsRecoveryHost } from "./RebootRecovery.host.windows.ts";
import { assertV2RebootBoundary, assertV2RecoveryContinuation } from "./RebootRecovery.host.ts";

const fields = ["ab".repeat(16), "7", "100", "0"];
const prior = decodeV2WindowsRecoveryHost(fields);

it("requires a forward kernel BootId on the same host, not elapsed time or a new process", () => {
  expect(() =>
    assertV2RebootBoundary(prior, decodeV2WindowsRecoveryHost([fields[0]!, "8", "101", "0"])),
  ).not.toThrow();
  for (const value of [
    [fields[0]!, "7", "999", "0"],
    [fields[0]!, "6", "999", "0"],
    ["cd".repeat(16), "8", "101", "0"],
  ])
    expect(() => assertV2RebootBoundary(prior, decodeV2WindowsRecoveryHost(value))).toThrow();
  expect(() => assertV2RecoveryContinuation(prior, { ...prior, bootSeconds: 90 })).not.toThrow();
  expect(() => assertV2RebootBoundary(prior, { ...prior, bootSeconds: 9999 })).toThrow("same boot");
  expect(() =>
    assertV2RecoveryContinuation(prior, { ...prior, bootSession: "windows-kernel:6" }),
  ).toThrow();
});

it("rejects unknown layouts, placeholder host identities and unbounded generations", () => {
  for (const value of [
    [],
    [...fields, "extra"],
    ["0".repeat(32), "7", "100", "0"],
    [fields[0]!, "4294967296", "100", "0"],
    [fields[0]!, "-1", "100", "0"],
    [fields[0]!, "7", "100", "1000000"],
    [fields[0]!, "7", "NaN", "0"],
  ])
    expect(() => decodeV2WindowsRecoveryHost(value)).toThrow();
});
