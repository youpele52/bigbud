import type { MuseSettings } from "@bigbud/contracts";
import type { ServerProviderUsageLimits } from "@bigbud/contracts/server/usageLimits.ts";

import { usageLimitsStatus } from "../../providerUsageLimits.ts";
import { runProcess } from "../../../utils/processRunner.ts";
import type { MuseHostFactory, MuseTransport } from "./Client.ts";
import { resolveMuseLaunch } from "./Client.platform.ts";
import { MUSE_USAGE_SOURCE, normalizeMuseUsage } from "./Provider.usageLimits.normalize.ts";
import { museUsageObservations, type MuseUsageObservations } from "./Usage.observations.ts";

/** Session observations older than this defer to a fresh CLI read. */
const MUSE_OBSERVATION_MAX_AGE_MS = 10 * 60_000;
const MUSE_USAGE_CLI_TIMEOUT_MS = 15_000;

export type MuseUsageCli = (binaryPath: string) => Promise<unknown>;

/** `muse usage --json`: reads the allowance without a model turn (CLI ≥ 1.4.13). */
export const runMuseUsageCli: MuseUsageCli = async (binaryPath) => {
  const launch = resolveMuseLaunch(binaryPath, process.platform, process.env, undefined, [
    "usage",
    "--json",
  ]);
  const result = await runProcess(launch.command, launch.args, {
    timeoutMs: MUSE_USAGE_CLI_TIMEOUT_MS,
    env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" },
    maxBufferBytes: 64 * 1024,
    allowNonZeroExit: true,
  });
  const line = result.stdout.trim().split("\n").at(-1);
  if (!line) throw new Error("Muse usage CLI printed nothing.");
  return JSON.parse(line) as unknown;
};

export interface MuseUsageReadInput {
  readonly settings: MuseSettings;
  /** An already-open host (the status check's discovery host); otherwise one is started. */
  readonly transport?: MuseTransport;
  readonly hostFactory: MuseHostFactory;
  readonly cli?: MuseUsageCli;
  readonly observations?: MuseUsageObservations;
  readonly now?: () => number;
}

async function readFromHost(input: MuseUsageReadInput): Promise<unknown> {
  let owned: MuseTransport | undefined;
  try {
    const transport =
      input.transport ??
      (owned = await input.hostFactory({
        binaryPath: input.settings.binaryPath,
        cwd: process.cwd(),
      }));
    const result = await transport.request("usage/read", {});
    return (result as { usage?: unknown }).usage;
  } catch {
    return undefined;
  } finally {
    await owned?.close().catch(() => undefined);
  }
}

/**
 * Muse subscription limits, in order: MSP `usage/read` on a host, the newest
 * `usage/changed` observation from a live session host, then
 * `muse usage --json`. An account without a subscription allowance (for
 * example pay-as-you-go API credit) is `unavailable`, which the usage page
 * hides, exactly like other providers without subscription windows.
 */
export async function readMuseUsageLimits(
  input: MuseUsageReadInput,
): Promise<ServerProviderUsageLimits> {
  const now = input.now ?? Date.now;
  const checkedAt = new Date(now()).toISOString();
  if (!input.settings.enabled)
    return usageLimitsStatus(MUSE_USAGE_SOURCE, checkedAt, "unavailable");
  try {
    const observed =
      (await readFromHost(input)) ??
      (input.observations ?? museUsageObservations).latest(now(), MUSE_OBSERVATION_MAX_AGE_MS);
    if (observed !== undefined) return normalizeMuseUsage(observed, checkedAt);

    const report = (await (input.cli ?? runMuseUsageCli)(input.settings.binaryPath)) as {
      readonly allowance?: unknown;
      readonly reason?: unknown;
    };
    if (report.allowance === null || report.allowance === undefined) {
      // no_allowance, api_key, not signed in, server_sent_no_usage: no windows to show.
      return usageLimitsStatus(MUSE_USAGE_SOURCE, checkedAt, "unavailable");
    }
    return normalizeMuseUsage(report.allowance, checkedAt);
  } catch {
    return usageLimitsStatus(MUSE_USAGE_SOURCE, checkedAt, "error");
  }
}
