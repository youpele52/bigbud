import { afterEach, describe, expect, it, vi } from "vitest";
import { runProcess } from "../utils/processRunner.ts";
import { sampleSshMonitor } from "./sshMonitor.ts";

vi.mock("../utils/processRunner.ts", () => ({ runProcess: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(runProcess).mockReset();
});

const output = `###OS###
Linux
###HOST###
demo
###ARCH###
x86_64
###KERNEL###
6.1
###CPU1###
cpu 100 0 0 900 0
###CPU2###
cpu 150 0 0 950 0
###MEM###
MemTotal: 4096 kB
MemAvailable: 2048 kB
###UPTIME###
10 0
###DF###
Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/vda1 100 40 60 40% /
###NET###
header
header
###TEMP###
###END###
`;

describe("shared read-only SSH sampling", () => {
  it("coalesces concurrent requests per target with a bounded noninteractive transport", async () => {
    const run = vi.mocked(runProcess);
    run.mockResolvedValue({ stdout: output, stderr: "", code: 0, signal: null, timedOut: false });
    const target = "ssh:host=monitor-test&user=deploy&auth=ssh-key";
    const [first, second] = await Promise.all([sampleSshMonitor(target), sampleSshMonitor(target)]);
    expect(first).toEqual(second);
    expect(await sampleSshMonitor(target)).toEqual(first);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toBe("ssh");
    expect(run.mock.calls[0]?.[1]).toContain("StrictHostKeyChecking=yes");
    expect(run.mock.calls[0]?.[1].join(" ")).toContain("--sort=-%cpu");
    expect(run.mock.calls[0]?.[1].join(" ")).toContain("head -n 1001");
    expect(run.mock.calls[0]?.[2]).toMatchObject({
      timeoutMs: 4_000,
      maxBufferBytes: 512 * 1024,
      shell: false,
    });
  });
  it("derives interface and host network rates from consecutive fresh reads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const run = vi.mocked(runProcess);
    const withNetwork = (received: number, transmitted: number) =>
      output.replace(
        "header\nheader\n",
        `header\nheader\n eth0: ${received} 0 0 0 0 0 0 0 ${transmitted} 0 0 0 0 0 0 0\n`,
      );
    run.mockResolvedValueOnce({
      stdout: withNetwork(100, 200),
      stderr: "",
      code: 0,
      signal: null,
      timedOut: false,
    });
    run.mockResolvedValueOnce({
      stdout: withNetwork(700, 800),
      stderr: "",
      code: 0,
      signal: null,
      timedOut: false,
    });
    const target = "ssh:host=monitor-rates&auth=ssh-key";
    const first = await sampleSshMonitor(target);
    expect(first.networkReceivedBytesPerSecond?.status).toBe("warming");
    vi.setSystemTime(7_000);
    const second = await sampleSshMonitor(target);
    expect(second.networkReceivedBytesPerSecond?.value).toBe(100);
    expect(second.networkTransmittedBytesPerSecond?.value).toBe(100);
    expect(second.interfaces[0]?.receivedBytesPerSecond?.value).toBe(100);
  });
});
