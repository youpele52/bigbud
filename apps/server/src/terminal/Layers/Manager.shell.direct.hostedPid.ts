/**
 * Keeps a hosted Direct SSH record (plan M7) in step with its host PTY: the remote login shell's
 * PID is stored when the launch marker arrives, a reattached PTY gets the stored PID back (so it
 * keeps real owner busy hints after a backend restart instead of staying `unknown`), and the
 * record is released when the PTY exits. Writes are serialised and compare the exact record, so
 * a release never races a PID update into a stale copy.
 *
 * @module Manager.shell.direct.hostedPid
 */
import type { PtyProcess } from "../Services/PTY";
import type {
  HostedDirectShellOwner,
  HostedDirectShellOwnerStore,
} from "./DirectShellLaunch.hosted";
import { createRemoteShellPidReader } from "./Manager.remote-identity";
import type { TerminalSessionState } from "./Manager.types";

export type HostedRecordStore = Pick<
  HostedDirectShellOwnerStore,
  "releaseHosted" | "setHostedRemoteShellPid"
>;

export function trackHostedDirectShellRecord(input: {
  readonly store: HostedRecordStore;
  readonly record: HostedDirectShellOwner;
  readonly process: PtyProcess;
  readonly session: Pick<TerminalSessionState, "runtimeGeneration" | "remoteShellPid">;
  readonly log?: (message: string, detail: Record<string, unknown>) => void;
}): void {
  const { store, process, session } = input;
  let latest = input.record;
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (work: () => Promise<void>) => {
    queue = queue.then(work).catch((cause: unknown) =>
      input.log?.("hosted SSH record update failed", {
        ownerKey: latest.ownerKey,
        cause: String(cause),
      }),
    );
  };
  const setPid = (pid: number | undefined) =>
    enqueue(async () => {
      if (!store.setHostedRemoteShellPid || latest.remoteShellPid === pid) return;
      latest = (await store.setHostedRemoteShellPid(latest, pid)) ?? latest;
    });

  if (process.recovered === true) {
    // The same PTY printed this PID at its launch; the marker never repeats.
    if (latest.remoteShellPid !== undefined) session.remoteShellPid = latest.remoteShellPid;
  } else {
    // A fresh PTY under a kept record: the old PID names another shell.
    if (latest.remoteShellPid !== undefined) setPid(undefined);
    let found = false;
    const read = createRemoteShellPidReader(session.runtimeGeneration, (pid) => {
      found = true;
      setPid(pid);
    });
    const stop = process.onData((data) => {
      if (found) return;
      read(data);
      if (found) queueMicrotask(stop);
    });
  }
  process.onExit(() => {
    // An interruption (the host or backend went away) is not an exit: keep the record.
    if (process.interruptionReason) return;
    enqueue(async () => {
      await store.releaseHosted(latest);
    });
  });
}
