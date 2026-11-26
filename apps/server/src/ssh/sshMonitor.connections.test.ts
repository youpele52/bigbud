import { afterEach, describe, expect, it, vi } from "vitest";
import { runProcess } from "../utils/processRunner.ts";
import {
  forgetSshMonitorCaller,
  forgetSshMonitorTarget,
  isConnectedSshMonitorTarget,
  sshMonitorLease,
  isHealthySshMonitorTarget,
  recordSshMonitorSample,
  recordVerifiedSshMonitorTarget,
  sshMonitorCallerId,
} from "./sshMonitor.connections.ts";
import type { SshMonitorHealthOwner } from "./sshMonitor.healthOwner.ts";

vi.mock("../utils/processRunner.ts", () => ({ runProcess: vi.fn() }));
const key = "ssh:host=connection-test&auth=ssh-key";
const password = "ssh:host=password-test&auth=password";
const clientA = "server-one:1";
const clientB = "server-one:2";
const mockHealth = () => vi.fn<SshMonitorHealthOwner["sampleHealth"]>();
afterEach(() => {
  forgetSshMonitorTarget(key);
  forgetSshMonitorTarget(password);
  vi.mocked(runProcess).mockReset();
  vi.useRealTimers();
});

describe("selected SSH monitor health owner", () => {
  it("samples only admitted targets, even when legacy verification is fresh", async () => {
    const sampleHealth = mockHealth().mockResolvedValue("reachable");
    const owner = { sampleHealth };
    expect(await isConnectedSshMonitorTarget(key, clientA, owner)).toBe(false);
    recordVerifiedSshMonitorTarget(key, clientA);
    expect(await isConnectedSshMonitorTarget(key, clientB, owner)).toBe(false);
    expect(sampleHealth).not.toHaveBeenCalled();

    expect(await isConnectedSshMonitorTarget(key, clientA, owner)).toBe(true);
    expect(sampleHealth).toHaveBeenCalledExactlyOnceWith(key, expect.any(AbortSignal));
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("limits positive freshness to the selected owner and target", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    recordVerifiedSshMonitorTarget(key, clientA);
    recordVerifiedSshMonitorTarget(key, clientB);
    const sampleHealth = mockHealth().mockResolvedValue("reachable");
    const owner = { sampleHealth };
    vi.setSystemTime(6_000);
    expect(await isConnectedSshMonitorTarget(key, clientA, owner)).toBe(true);
    expect(await isConnectedSshMonitorTarget(key, clientB, owner)).toBe(true);
    expect(sampleHealth).toHaveBeenCalledExactlyOnceWith(key, expect.any(AbortSignal));

    const otherOwner = { sampleHealth: mockHealth().mockResolvedValue("unavailable") };
    expect(await isConnectedSshMonitorTarget(key, clientA, otherOwner)).toBe(false);
    expect(otherOwner.sampleHealth).toHaveBeenCalledExactlyOnceWith(key, expect.any(AbortSignal));
    recordVerifiedSshMonitorTarget(password, clientA);
    expect(await isConnectedSshMonitorTarget(password, clientA, owner)).toBe(true);
    expect(sampleHealth).toHaveBeenLastCalledWith(password, expect.any(AbortSignal));
    expect(runProcess).not.toHaveBeenCalled();

    // Owner health must not refresh the stale legacy path or vice versa.
    vi.mocked(runProcess).mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      timedOut: false,
    });
    expect(await isConnectedSshMonitorTarget(key, clientA)).toBe(true);
    expect(runProcess).toHaveBeenCalledTimes(1);
    vi.setSystemTime(11_000);
    recordSshMonitorSample(key, 11_000, clientA, sshMonitorLease(key, clientA)!);
    sampleHealth.mockResolvedValue("unavailable");
    expect(await isConnectedSshMonitorTarget(key, clientA, owner)).toBe(false);
    expect(sampleHealth).toHaveBeenCalledTimes(3);
    expect(runProcess).toHaveBeenCalledTimes(1);
  });

  it("does not join a pending legacy probe or allow a newer monitor sample to mask owner unavailability", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    recordVerifiedSshMonitorTarget(key, clientA);
    const lease = sshMonitorLease(key, clientA)!;
    const legacy = Promise.withResolvers<Awaited<ReturnType<typeof runProcess>>>();
    vi.mocked(runProcess).mockReturnValue(legacy.promise);
    const ownerResult = Promise.withResolvers<"unavailable">();
    const sampleHealth = mockHealth().mockReturnValue(ownerResult.promise);
    const owner = { sampleHealth };
    vi.setSystemTime(6_000);
    const pendingLegacy = isConnectedSshMonitorTarget(key, clientA);
    const pendingOwner = isConnectedSshMonitorTarget(key, clientA, owner);
    vi.setSystemTime(6_100);
    recordSshMonitorSample(key, 6_100, clientA, lease);
    ownerResult.resolve("unavailable");
    await expect(pendingOwner).resolves.toBe(false);
    expect(sampleHealth).toHaveBeenCalledExactlyOnceWith(key, expect.any(AbortSignal));
    expect(runProcess).toHaveBeenCalledTimes(1);
    expect(sshMonitorLease(key, clientA)).toBe(lease);

    legacy.reject(new Error("older legacy probe failed"));
    await expect(pendingLegacy).resolves.toBe(true);
  });

  it("denies a burst on owner unavailability or error without revoking leases or falling back", async () => {
    recordVerifiedSshMonitorTarget(key, clientA);
    recordVerifiedSshMonitorTarget(key, clientB);
    const leaseA = sshMonitorLease(key, clientA);
    const leaseB = sshMonitorLease(key, clientB);
    const sampleHealth = mockHealth()
      .mockResolvedValueOnce("unavailable")
      .mockRejectedValueOnce(new Error("owner exited"))
      .mockImplementationOnce(() => {
        throw new Error("owner closed");
      })
      .mockResolvedValueOnce("reachable");
    const owner = { sampleHealth };

    for (let i = 1; i <= 3; i++) {
      const results = await Promise.all(
        Array.from({ length: 64 }, (_, j) =>
          isConnectedSshMonitorTarget(key, j % 2 === 0 ? clientA : clientB, owner),
        ),
      );
      expect(results).toEqual(Array.from({ length: 64 }, () => false));
      expect(sampleHealth).toHaveBeenCalledTimes(i);
      expect(sshMonitorLease(key, clientA)).toBe(leaseA);
      expect(sshMonitorLease(key, clientB)).toBe(leaseB);
    }
    expect(await isConnectedSshMonitorTarget(key, clientB, owner)).toBe(true);
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("coalesces pending requests without authorizing replaced or disconnected leases", async () => {
    recordVerifiedSshMonitorTarget(key, clientA);
    recordVerifiedSshMonitorTarget(key, clientB);
    const oldA = sshMonitorLease(key, clientA);
    const { promise, resolve } = Promise.withResolvers<"reachable">();
    const sampleHealth = mockHealth().mockReturnValue(promise);
    const owner = { sampleHealth };
    const requests = Array.from({ length: 64 }, (_, j) =>
      isConnectedSshMonitorTarget(key, j % 2 === 0 ? clientA : clientB, owner),
    );
    recordVerifiedSshMonitorTarget(key, clientA);
    forgetSshMonitorCaller(clientB);
    const currentA = isConnectedSshMonitorTarget(key, clientA, owner);
    resolve("reachable");

    expect(await Promise.all(requests)).toEqual(Array.from({ length: 64 }, () => false));
    expect(await currentA).toBe(true);
    expect(sshMonitorLease(key, clientA)).not.toBe(oldA);
    expect(sshMonitorLease(key, clientB)).toBeNull();
    expect(sampleHealth).toHaveBeenCalledExactlyOnceWith(key, expect.any(AbortSignal));
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("isolates a cancelled selected reader from a peer sharing the native probe", async () => {
    recordVerifiedSshMonitorTarget(key, clientA);
    recordVerifiedSshMonitorTarget(key, clientB);
    const result = Promise.withResolvers<"reachable">();
    const sampleHealth = mockHealth().mockReturnValue(result.promise);
    const owner = { sampleHealth };
    const reader = new AbortController();
    const cancelled = isConnectedSshMonitorTarget(key, clientA, owner, reader.signal);
    const peer = isConnectedSshMonitorTarget(key, clientB, owner);
    reader.abort();
    await expect(cancelled).resolves.toBe(false);
    expect(sampleHealth).toHaveBeenCalledTimes(1);
    expect(sampleHealth.mock.calls[0]![1].aborted).toBe(false);
    result.resolve("reachable");
    await expect(peer).resolves.toBe(true);
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("does not let an unreachable result revoke a replacement connection", async () => {
    recordVerifiedSshMonitorTarget(key, clientA);
    const { promise, resolve } = Promise.withResolvers<"unreachable">();
    const sampleHealth = mockHealth().mockReturnValueOnce(promise).mockResolvedValue("reachable");
    const owner = { sampleHealth };
    const pending = isConnectedSshMonitorTarget(key, clientA, owner);
    forgetSshMonitorTarget(key);
    recordVerifiedSshMonitorTarget(key, clientA);
    const replacement = sshMonitorLease(key, clientA);
    expect(await isConnectedSshMonitorTarget(key, clientA, owner)).toBe(true);
    resolve("unreachable");
    expect(await pending).toBe(false);
    expect(sshMonitorLease(key, clientA)).toBe(replacement);
    expect(sampleHealth).toHaveBeenCalledTimes(2);
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("revokes admitted leases on unreachable unless a newer monitor sample supersedes it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    recordVerifiedSshMonitorTarget(key, clientA);
    recordVerifiedSshMonitorTarget(key, clientB);
    const leaseA = sshMonitorLease(key, clientA)!;
    const leaseB = sshMonitorLease(key, clientB)!;
    const { promise, resolve } = Promise.withResolvers<"unreachable">();
    const sampleHealth = mockHealth().mockReturnValueOnce(promise).mockResolvedValue("unreachable");
    const owner = { sampleHealth };
    const pending = isConnectedSshMonitorTarget(key, clientA, owner);
    vi.setSystemTime(1_100);
    recordSshMonitorSample(key, 1_100, clientB, leaseB);
    resolve("unreachable");
    expect(await pending).toBe(true);
    expect(sshMonitorLease(key, clientA)).toBe(leaseA);
    expect(sshMonitorLease(key, clientB)).toBe(leaseB);

    vi.setSystemTime(1_200);
    expect(await isConnectedSshMonitorTarget(key, clientA, owner)).toBe(false);
    expect(sshMonitorLease(key, clientA)).toBeNull();
    expect(sshMonitorLease(key, clientB)).toBeNull();
    expect(sampleHealth).toHaveBeenCalledTimes(2);
    expect(runProcess).not.toHaveBeenCalled();
  });
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
