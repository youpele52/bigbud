import { randomUUID } from "node:crypto";
import { lstat, rm, writeFile } from "node:fs/promises";
import Path from "node:path";
import * as Schema from "effect/Schema";
import { CopilotRuntimeJob } from "@bigbud/contracts/server/copilotRuntime";
import { installCopilotRuntime } from "./Runtime.install.ts";
import { localCopilotRelease } from "./Runtime.discovery.ts";
import {
  readRuntimeState,
  runtimeOwnerAlive,
  withCopilotRuntimeLock,
  writeRuntimeState,
} from "@bigbud/shared/copilotRuntime.storage";
import { uninstallCopilotRuntime } from "./Runtime.lifecycle.ts";
import { readManagedCopilotVersion } from "@bigbud/shared/copilotRuntime.paths";

const Record = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(2147483647)),
  job: CopilotRuntimeJob,
});
const decode = Schema.decodeUnknownSync(Record);
type MutableJob = { -readonly [K in keyof CopilotRuntimeJob]: CopilotRuntimeJob[K] };
const activeJobs = new Set<string>();
export const runtimeJobBusy = (job: CopilotRuntimeJob | null) =>
  job !== null && ["downloading", "verifying", "installing"].includes(job.phase);

/** Call under the short transaction lock. A crashed job is visible, never silently restarted. */
export async function readCopilotJob(root: string): Promise<CopilotRuntimeJob | null> {
  const raw = await readRuntimeState(root, ".job.json");
  if (raw === undefined) return null;
  const record = decode(raw);
  if (
    runtimeJobBusy(record.job) &&
    (!runtimeOwnerAlive(record.pid) ||
      (record.pid === process.pid && !activeJobs.has(record.job.id)))
  ) {
    const job: CopilotRuntimeJob = {
      ...record.job,
      phase: "error",
      error:
        "Copilot setup was interrupted. Retry to start a new download; the previous runtime is preserved.",
    };
    await writeRuntimeState(root, ".job.json", { ...record, job });
    return job;
  }
  return record.job;
}

async function update(root: string, job: CopilotRuntimeJob) {
  await withCopilotRuntimeLock(root, async () => {
    if ((await readCopilotJob(root))?.id === job.id)
      await writeRuntimeState(root, ".job.json", { pid: process.pid, job });
  });
}

/** Starts once in server ownership; renderer disconnects and status polling do not cancel it. */
export async function startCopilotJob(root: string, uninstall: boolean): Promise<void> {
  const release = localCopilotRelease();
  const job = await withCopilotRuntimeLock(root, async () => {
    if (runtimeJobBusy(await readCopilotJob(root)))
      throw new Error("Another Copilot runtime operation is already in progress.");
    const reuse =
      !uninstall &&
      readManagedCopilotVersion(root, `${release.version}/${release.target}`) !== undefined;
    const job: MutableJob = {
      operation: uninstall ? "uninstall" : "install",
      id: randomUUID(),
      phase: uninstall || reuse ? "installing" : "downloading",
      version: release.version,
      transferredBytes: 0,
      totalBytes: uninstall || reuse ? 0 : release.archiveBytes,
      error: null,
    };
    await writeRuntimeState(root, ".onboarding.json", true);
    activeJobs.add(job.id);
    try {
      await writeRuntimeState(root, ".job.json", { pid: process.pid, job });
    } catch (error) {
      activeJobs.delete(job.id);
      throw error;
    }
    return job;
  });
  const run = async () => {
    const controller = new AbortController();
    const cancelFile = Path.join(root, `.cancel-${job.id}`);
    let pending = Promise.resolve();
    let last = 0;
    const cancelTimer = setInterval(() => {
      void lstat(cancelFile)
        .then(() => controller.abort())
        .catch(() => undefined);
    }, 250);
    cancelTimer.unref();
    try {
      if (uninstall) {
        await uninstallCopilotRuntime(root);
        job.phase = "uninstalled";
      } else {
        await installCopilotRuntime({
          root,
          release,
          signal: controller.signal,
          onProgress: (progress) => {
            if (progress.phase === "downloading" && Date.now() - last < 250) return;
            last = Date.now();
            Object.assign(job, progress);
            const snapshot = { ...job };
            pending = pending.then(() => update(root, snapshot));
            // Observe early rejection while keeping it available to the final await.
            void pending.catch(() => undefined);
          },
        });
        job.phase = "installed";
      }
      await pending;
    } catch (error) {
      await pending.catch(() => undefined);
      job.phase = controller.signal.aborted ? "cancelled" : "error";
      job.error = controller.signal.aborted
        ? null
        : error instanceof Error
          ? error.message.slice(0, 2048)
          : String(error).slice(0, 2048);
    } finally {
      clearInterval(cancelTimer);
      try {
        await rm(cancelFile, { force: true });
        await update(root, job);
      } finally {
        activeJobs.delete(job.id);
      }
    }
  };
  void run().catch((error) =>
    console.error("[copilot-runtime] Could not persist runtime job outcome", error),
  );
}

export async function cancelCopilotJob(root: string, id: string | undefined): Promise<void> {
  await withCopilotRuntimeLock(root, async () => {
    const job = await readCopilotJob(root);
    if (!id || !/^[a-f0-9-]{36}$/.test(id) || job?.id !== id || job.phase !== "downloading")
      throw new Error("Only the current Copilot download can be cancelled.");
    await writeFile(Path.join(root, `.cancel-${id}`), "", { flag: "wx", mode: 0o600 }).catch(
      (error) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
  });
}
