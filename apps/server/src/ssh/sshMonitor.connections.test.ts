import { afterEach, describe, expect, it, vi } from "vitest";
import { runProcess } from "../utils/processRunner.ts";
import {
  forgetSshMonitorTarget,
  isConnectedSshMonitorTarget,
  sshMonitorLease,
  isHealthySshMonitorTarget,
  recordSshMonitorSample,
  recordVerifiedSshMonitorTarget,
  sshMonitorCallerId,
} from "./sshMonitor.connections.ts";

vi.mock("../utils/processRunner.ts", () => ({ runProcess: vi.fn() }));
const key = "ssh:host=connection-test&auth=ssh-key";
const password = "ssh:host=password-test&auth=password";
const clientA = "server-one:1";
const clientB = "server-one:2";
afterEach(() => {
  forgetSshMonitorTarget(key);
  forgetSshMonitorTarget(password);
  vi.mocked(runProcess).mockReset();
  vi.useRealTimers();
});

describe("server-owned SSH connection health", () => {
  it("does not admit unknown targets and revokes key leases on the first failed probe", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    expect(await isConnectedSshMonitorTarget(key, clientA)).toBe(false);
    recordVerifiedSshMonitorTarget(key, clientA);
    const lease = sshMonitorLease(key, clientA)!;
    expect(sshMonitorLease(key, clientB)).toBeNull();
    expect(await isConnectedSshMonitorTarget(key, clientB)).toBe(false);
    expect(await isConnectedSshMonitorTarget(key, clientA)).toBe(true);
    vi.mocked(runProcess).mockRejectedValue(new Error("network offline"));
    vi.setSystemTime(6_000);
    expect(await isConnectedSshMonitorTarget(key, clientA)).toBe(false);
    expect(sshMonitorLease(key, clientA)).toBeNull();
    expect(isHealthySshMonitorTarget(key, clientA, lease)).toBe(false);
    recordSshMonitorSample(key, 1_000, clientA, lease);
    expect(isHealthySshMonitorTarget(key, clientA, lease)).toBe(false);
  });

  it("drops a disconnected password session on the first failed health check", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    recordVerifiedSshMonitorTarget(password, clientA);
    vi.mocked(runProcess).mockRejectedValue(new Error("master socket closed"));
    vi.setSystemTime(6_000);
    expect(await isConnectedSshMonitorTarget(password, clientA)).toBe(false);
    expect(sshMonitorLease(password, clientA)).toBeNull();
  });

  it("does not revoke a caller when a newer sample succeeds during an older failed probe", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    recordVerifiedSshMonitorTarget(key, clientA);
    const lease = sshMonitorLease(key, clientA)!;
    let fail!: (error: Error) => void;
    vi.mocked(runProcess).mockImplementation(
      () => new Promise((_resolve, reject) => (fail = reject)),
    );
    vi.setSystemTime(6_000);
    const pending = isConnectedSshMonitorTarget(key, clientA);
    vi.setSystemTime(6_100);
    recordSshMonitorSample(key, 6_100, clientA, lease);
    fail(new Error("older probe failed"));
    await expect(pending).resolves.toBe(true);
    expect(sshMonitorLease(key, clientA)).toBe(lease);
  });

  it("ignores missing or invalid caller identifiers and invalidates an in-flight lease on reverify", () => {
    expect(sshMonitorCallerId("server-one", NaN)).toBeNull();
    expect(sshMonitorCallerId(undefined, 1)).toBeNull();
    recordVerifiedSshMonitorTarget(key, null);
    expect(sshMonitorLease(key, "server-one:0")).toBeNull();
    expect(sshMonitorLease(key, sshMonitorCallerId("server-two", 1)!)).toBeNull();
    recordVerifiedSshMonitorTarget(key, clientA);
    const oldLease = sshMonitorLease(key, clientA)!;
    recordVerifiedSshMonitorTarget(key, clientB);
    expect(sshMonitorLease(key, clientA)).toBe(oldLease);
    recordVerifiedSshMonitorTarget(key, clientA);
    expect(isHealthySshMonitorTarget(key, clientA, oldLease)).toBe(false);
    expect(sshMonitorLease(key, clientB)).not.toBeNull();
  });
});
