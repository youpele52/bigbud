import type { MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";

import { parseSshMonitor } from "./sshMonitor.parse.ts";
import { applyNetworkRates, cpuSection, withCpuWindow } from "./sshMonitor.rates.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";
import {
  readSshOwnerProductionOwner,
  type SshOwnerProductionRegistration,
} from "./sshOwnerProductionRegistry.ts";
import { SshOwnerRequiredError } from "./sshOwnerRequired.ts";
import { descriptorServesTarget } from "./sshOwnerProductionTargets.ts";

/**
 * Remote system statistics for an SSH target (C03 / W7).
 *
 * One owner verb, `sample_system_status` (Request 180), runs a fixed read-only
 * recipe over the exact target's verified master; nothing in TypeScript
 * launches SSH. Sampling is bounded here: one shared in-flight sample per
 * target, a 5 s freshness window shared by every caller, at most 32 targets,
 * and idle entries evicted after 30 s. A failed sample is never cached. CPU
 * usage is the delta between two successive samples; a target without a
 * retained previous sample takes a second sample after 250 ms.
 *
 * @module sshMonitor
 */
export type SshMonitorSampleSource = (target: string) => Promise<string>;

const MAX_HOSTS = 32;
const FRESH_MS = 5_000;
const IDLE_MS = 30_000;
const CPU_WINDOW_MS = 250;

interface Entry {
  snapshot: MonitorSnapshot | undefined;
  cpu: string | undefined;
  at: number;
  inFlight: Promise<MonitorSnapshot> | undefined;
}

/** The live production owner's sample for this exact target; refused typed without one. */
export function productionSystemStatusSource(
  read: () => SshOwnerProductionRegistration | undefined = readSshOwnerProductionOwner,
): SshMonitorSampleSource {
  return async (target) => {
    const live = read();
    if (!live) throw new SshOwnerRequiredError();
    const descriptor = await live.descriptorFor(target);
    if (!descriptorServesTarget(descriptor, target))
      throw new PickerProofOwnerError("targetMismatch");
    return live.handle.target(descriptor).sampleSystemStatus();
  };
}

export function makeSshMonitorSampler(
  source: SshMonitorSampleSource,
  options: { readonly now?: () => number; readonly pause?: (ms: number) => Promise<void> } = {},
) {
  const now = options.now ?? Date.now;
  const pause =
    options.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const cache = new Map<string, Entry>();

  const sampleOnce = async (target: string, entry: Entry): Promise<MonitorSnapshot> => {
    let previousCpu = entry.cpu;
    let sample = await source(target);
    if (previousCpu === undefined) {
      previousCpu = cpuSection(sample) ?? "";
      await pause(CPU_WINDOW_MS);
      sample = await source(target);
    }
    const snapshot = parseSshMonitor(
      withCpuWindow(sample, previousCpu),
      now(),
      (entry.snapshot?.sequence ?? 0) + 1,
    );
    applyNetworkRates(snapshot, entry.snapshot);
    entry.cpu = cpuSection(sample);
    entry.snapshot = snapshot;
    entry.at = now();
    return snapshot;
  };

  return async function sample(target: string): Promise<MonitorSnapshot> {
    const at = now();
    const existing = cache.get(target);
    if (existing?.snapshot && at - existing.at < FRESH_MS) return existing.snapshot;
    if (existing?.inFlight) return existing.inFlight;
    for (const [key, value] of cache)
      if (at - value.at > IDLE_MS && !value.inFlight) cache.delete(key);
    if (!existing && cache.size >= MAX_HOSTS) throw new Error("Too many active remote monitors");
    const entry: Entry = existing ?? {
      at,
      snapshot: undefined,
      cpu: undefined,
      inFlight: undefined,
    };
    cache.set(target, entry);
    const task = sampleOnce(target, entry);
    entry.inFlight = task;
    try {
      return await task;
    } catch (error) {
      entry.snapshot = undefined;
      entry.cpu = undefined;
      throw error;
    } finally {
      entry.inFlight = undefined;
    }
  };
}

const productionSampler = makeSshMonitorSampler(productionSystemStatusSource());

/** Shared, bounded sample of one connected SSH target through the production owner. */
export function sampleSshMonitor(target: string): Promise<MonitorSnapshot> {
  return productionSampler(target);
}
