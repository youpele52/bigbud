import { expect, it } from "vitest";
import { decodeV2LinuxRecoveryHost, readV2LinuxRecoveryHost } from "./RebootRecovery.host.linux.ts";
import { assertV2RebootBoundary } from "./RebootRecovery.host.ts";

const machine = "ab".repeat(16);
const boot = "12345678-1234-1234-1234-123456789abc";
const next = "abcdef01-1234-1234-1234-123456789abc";
const before = decodeV2LinuxRecoveryHost(machine, boot, "cpu 1 2 3\nbtime 100\n");

it("Linux requires both a kernel boot-session transition and a later boot on the same host", () => {
  expect(() =>
    assertV2RebootBoundary(before, decodeV2LinuxRecoveryHost(machine, next, "btime 200")),
  ).not.toThrow();
  for (const after of [
    decodeV2LinuxRecoveryHost(machine, boot, "btime 200"), // clock-only changes cannot retire
    decodeV2LinuxRecoveryHost(machine, next, "btime 100"),
    decodeV2LinuxRecoveryHost("cd".repeat(16), next, "btime 200"),
  ])
    expect(() => assertV2RebootBoundary(before, after)).toThrow();
});

it("missing, malformed, duplicate and timestamp-only facts fail closed", () => {
  for (const inputs of [
    ["", boot, "btime 100"],
    ["0".repeat(32), boot, "btime 100"],
    [machine, "100", "btime 100"],
    [machine, boot, "uptime 100"],
    [machine, boot, "btime 100\nbtime 100"],
    [machine, boot, "btime 999999999999999999999"],
  ])
    expect(() => decodeV2LinuxRecoveryHost(inputs[0]!, inputs[1]!, inputs[2]!)).toThrow();
  expect(before.host).not.toContain(machine);
});

it.skipIf(process.platform !== "linux")(
  "reads stable native Linux evidence without using environment identity overrides",
  async () => {
    const first = await readV2LinuxRecoveryHost();
    expect(await readV2LinuxRecoveryHost()).toEqual(first);
    expect(() => assertV2RebootBoundary(first, first)).toThrow("same boot");
  },
);
