import { describe, expect, it } from "vitest";

import { makeSshMonitorSampler, productionSystemStatusSource } from "./sshMonitor.ts";
import { cpuSection, withCpuWindow } from "./sshMonitor.rates.ts";
import type { SshOwnerProductionRegistration } from "./sshOwnerProductionRegistry.ts";
import { SshOwnerRequiredError } from "./sshOwnerRequired.ts";

const TARGET = "ssh:host=vps.example&user=dev";

function ownerSample(cpu: string, received: number) {
  return `###OS###
Linux
###HOST###
vps-1
###ARCH###
x86_64
###KERNEL###
6.1.0
###CPU###
${cpu}
###MEM###
MemTotal: 4096 kB
MemAvailable: 1024 kB
###UPTIME###
1234.5 3.0
###DF###
Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/vda1 10000 2000 8000 20% /
###NET###
Inter-|   Receive | Transmit
 face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed
 eth0: ${received} 1 0 0 0 0 0 0 2048 1 0 0 0 0 0 0
###PROCESS###
1 0 init 1024 2048 S 1200 0.5
###TEMP###
###END###
`;
}

function fakeSource(samples: string[]) {
  const calls: string[] = [];
  return {
    calls,
    source: async (target: string) => {
      calls.push(target);
      const next = samples.shift();
      if (next === undefined) throw new Error("no sample");
      return next;
    },
  };
}

describe("owner-backed SSH monitor sampling", () => {
  it("windows CPU across two owner samples and never sleeps inside the recipe", () => {
    const sample = ownerSample("cpu 125 0 125 850 0 0 0 0 0 0", 1);
    expect(cpuSection(sample)).toBe("cpu 125 0 125 850 0 0 0 0 0 0\n");
    const merged = withCpuWindow(sample, "cpu 100 0 100 800 0 0 0 0 0 0\n");
    expect(merged.startsWith("###CPU1###\ncpu 100")).toBe(true);
    expect(merged).toContain("###CPU2###\ncpu 125");
    expect(merged).not.toMatch(/^###CPU###$/m);
  });

  it("takes a second sample for the first window, then shares one fresh sample", async () => {
    let clock = 1_000;
    const pauses: number[] = [];
    const { calls, source } = fakeSource([
      ownerSample("cpu 100 0 100 800 0 0 0 0 0 0", 1_000),
      ownerSample("cpu 125 0 125 850 0 0 0 0 0 0", 1_000),
      ownerSample("cpu 150 0 150 900 0 0 0 0 0 0", 6_000),
    ]);
    const sample = makeSshMonitorSampler(source, {
      now: () => clock,
      pause: async (ms) => {
        pauses.push(ms);
      },
    });
    const [first, concurrent] = await Promise.all([sample(TARGET), sample(TARGET)]);
    expect(concurrent).toBe(first);
    expect(calls).toHaveLength(2);
    expect(pauses).toEqual([250]);
    expect(first.cpuPercent?.value).toBeCloseTo(50);
    expect(first.networkReceivedBytesPerSecond?.status).toBe("warming");
    clock += 1_000;
    expect(await sample(TARGET)).toBe(first);
    expect(calls).toHaveLength(2);
    clock += 4_000;
    const next = await sample(TARGET);
    expect(calls).toHaveLength(3);
    expect(next.sequence).toBe(2);
    expect(next.cpuPercent?.value).toBeCloseTo(50);
    expect(next.networkReceivedBytesPerSecond).toMatchObject({ status: "ready", value: 1_000 });
  });

  it("never caches a failed sample and bounds the number of targets", async () => {
    const { source } = fakeSource([]);
    const sample = makeSshMonitorSampler(source, { pause: async () => {} });
    await expect(sample(TARGET)).rejects.toThrow("no sample");
    await expect(sample(TARGET)).rejects.toThrow("no sample");
    const busy = makeSshMonitorSampler(() => new Promise<string>(() => {}));
    for (let index = 0; index < 32; index++) void busy(`ssh:host=h${index}&user=dev`);
    await expect(busy("ssh:host=extra&user=dev")).rejects.toThrow(
      "Too many active remote monitors",
    );
  });

  it("refuses typed without a live owner and samples the exact target otherwise", async () => {
    await expect(productionSystemStatusSource(() => undefined)(TARGET)).rejects.toBeInstanceOf(
      SshOwnerRequiredError,
    );
    const bound: string[] = [];
    const live = {
      descriptorFor: async (targetId: string) => ({ targetId, kind: "structured" }),
      handle: {
        target: (descriptor: { targetId: string }) => {
          bound.push(descriptor.targetId);
          return { sampleSystemStatus: async () => "###END###\n" };
        },
      },
    } as unknown as SshOwnerProductionRegistration;
    expect(await productionSystemStatusSource(() => live)(TARGET)).toBe("###END###\n");
    expect(bound).toEqual([TARGET]);
  });
});
