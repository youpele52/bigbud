import type { MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";
import { runProcess } from "../utils/processRunner.ts";
import { remoteReadOnlyInvocation } from "../terminal/Layers/Manager.remote-inspection.ts";
import { parseSshMonitor } from "./sshMonitor.parse.ts";

// All commands read kernel or user-visible metadata. No remote files are created or modified.
const COMMAND = `sh -c 'printf "###OS###\\n"; uname -s; printf "###HOST###\\n"; hostname; printf "###ARCH###\\n"; uname -m; printf "###KERNEL###\\n"; uname -r; printf "###CPU1###\\n"; head -n 65 /proc/stat; sleep 0.25; printf "###CPU2###\\n"; head -n 65 /proc/stat; printf "###MEM###\\n"; cat /proc/meminfo; printf "###UPTIME###\\n"; cat /proc/uptime; printf "###DF###\\n"; df -Pk; printf "###NET###\\n"; cat /proc/net/dev; printf "###PROCESS###\\n"; ps -eo pid=,ppid=,comm=,rss=,vsz=,stat=,etimes=,pcpu= --sort=-%cpu 2>/dev/null | head -n 1001; printf "###TEMP###\\n"; for file in /sys/class/thermal/thermal_zone*/temp; do if [ -r "$file" ]; then printf "%s " "$file"; cat "$file"; fi; done; printf "###END###\\n"'`;

interface Entry {
  snapshot: MonitorSnapshot | undefined;
  at: number;
  inFlight: Promise<MonitorSnapshot> | undefined;
}
const cache = new Map<string, Entry>();
const MAX_HOSTS = 32;
const FRESH_MS = 5_000;

/** Shared per-target in-flight read, bounded by deadline and output size; failed samples are never cached. */
export async function sampleSshMonitor(target: string): Promise<MonitorSnapshot> {
  const now = Date.now();
  const existing = cache.get(target);
  if (existing?.snapshot && now - existing.at < FRESH_MS) return existing.snapshot;
  if (existing?.inFlight) return existing.inFlight;
  for (const [key, value] of cache)
    if (now - value.at > 30_000 && !value.inFlight) cache.delete(key);
  if (!existing && cache.size >= MAX_HOSTS) throw new Error("Too many active remote monitors");
  const entry: Entry = existing ?? { at: now, snapshot: undefined, inFlight: undefined };
  cache.set(target, entry);
  const task = (async () => {
    const { command, args } = remoteReadOnlyInvocation(target, COMMAND);
    const result = await runProcess(command, args, {
      shell: false,
      timeoutMs: 4_000,
      settleOnTimeout: true,
      maxBufferBytes: 512 * 1024,
      outputMode: "error",
    });
    const snapshot = parseSshMonitor(
      result.stdout,
      Date.now(),
      (entry.snapshot?.sequence ?? 0) + 1,
    );
    const previous = entry.snapshot;
    const elapsed = previous ? (snapshot.sampledAtMs - previous.sampledAtMs) / 1_000 : 0;
    if (!previous && snapshot.interfaces.some((item) => item.name !== "lo")) {
      snapshot.networkReceivedBytesPerSecond = {
        value: 0,
        status: "warming",
        sampledAtMs: snapshot.sampledAtMs,
      };
      snapshot.networkTransmittedBytesPerSecond = {
        value: 0,
        status: "warming",
        sampledAtMs: snapshot.sampledAtMs,
      };
    }
    if (previous && elapsed > 0) {
      const oldInterfaces = new Map(previous.interfaces.map((item) => [item.name, item]));
      let received = 0;
      let transmitted = 0;
      let measured = false;
      snapshot.interfaces = snapshot.interfaces.map((item) => {
        const old = oldInterfaces.get(item.name);
        const rate = (current?: number, prior?: number) =>
          current !== undefined && prior !== undefined && current >= prior
            ? {
                value: (current - prior) / elapsed,
                status: "ready" as const,
                sampledAtMs: snapshot.sampledAtMs,
              }
            : undefined;
        const down = rate(item.receivedTotalBytes?.value, old?.receivedTotalBytes?.value);
        const up = rate(item.transmittedTotalBytes?.value, old?.transmittedTotalBytes?.value);
        if (item.name !== "lo") {
          measured ||= down !== undefined && up !== undefined;
          received += down?.value ?? 0;
          transmitted += up?.value ?? 0;
        }
        return {
          ...item,
          ...(down ? { receivedBytesPerSecond: down } : {}),
          ...(up ? { transmittedBytesPerSecond: up } : {}),
        };
      });
      if (measured) {
        snapshot.networkReceivedBytesPerSecond = {
          value: received,
          status: "ready",
          sampledAtMs: snapshot.sampledAtMs,
        };
        snapshot.networkTransmittedBytesPerSecond = {
          value: transmitted,
          status: "ready",
          sampledAtMs: snapshot.sampledAtMs,
        };
      }
    }
    entry.snapshot = snapshot;
    entry.at = Date.now();
    return snapshot;
  })();
  entry.inFlight = task;
  try {
    return await task;
  } catch (error) {
    entry.snapshot = undefined;
    throw error;
  } finally {
    entry.inFlight = undefined;
  }
}
