/**
 * Recovery for a deletion blocked by an unverifiable direct SSH/WSL shell record: the failure
 * toast offers "Forget remote shell and delete", which asks for confirmation, forgets only that
 * thread's records on the server, then retries the deletion.
 *
 * @module threadDeletionRemoteShell
 */
import type { NativeApi, OrchestrationEvent, ThreadId } from "@bigbud/contracts";

import { toastManager } from "~/components/ui/toast";
import { newCommandId } from "~/lib/utils";
import { dispatchCommandWithOutcomeRecovery } from "~/lib/orchestrationCommandRecovery";
import {
  getBatchFailedThreadDeletions,
  getFailedThreadDeletionToast,
  THREAD_DELETION_FAILED_TOAST_ID,
} from "~/logic/orchestration/thread-deletion.logic";
import { readNativeApi } from "~/rpc/nativeApi";

export const FORGET_REMOTE_SHELL_ACTION_LABEL = "Forget remote shell and delete";

/** The thread the shared deletion-failure toast currently describes. */
let toastThreadId: ThreadId | null = null;

export function forgetRemoteShellConfirmMessage(hosts: ReadonlyArray<string>): string {
  const where = hosts.length > 0 ? hosts.join(", ") : "a remote host";
  return [
    `Forget the remote shell on ${where} and delete this thread?`,
    `A shell on ${where} may still be running. bigbud cannot verify or stop it, and will stop ` +
      "tracking it. Stop it on that host yourself if it is still needed or still running.",
  ].join("\n\n");
}

/** Re-sends a person's deletion of one thread. */
export async function retryThreadDeletion(threadId: ThreadId): Promise<void> {
  const api = readNativeApi();
  if (!api) return;
  await dispatchCommandWithOutcomeRecovery(api, {
    type: "thread.delete",
    commandId: newCommandId(),
    threadId,
  });
}

export async function forgetRemoteShellAndDelete(input: {
  readonly api: Pick<NativeApi, "dialogs" | "terminal">;
  readonly threadId: ThreadId;
  readonly hosts: ReadonlyArray<string>;
  readonly retryDelete: () => Promise<void>;
}): Promise<boolean> {
  const forget = input.api.terminal.forgetRetainedShellOwners;
  if (!forget) return false;
  if (!(await input.api.dialogs.confirm(forgetRemoteShellConfirmMessage(input.hosts)))) {
    return false;
  }
  toastManager.close(THREAD_DELETION_FAILED_TOAST_ID);
  try {
    await forget({ threadId: input.threadId });
    await input.retryDelete();
    return true;
  } catch (error) {
    toastManager.add({
      id: THREAD_DELETION_FAILED_TOAST_ID,
      type: "error",
      title: "Could not forget the remote shell",
      description: error instanceof Error ? error.message : "The thread was not deleted.",
    });
    return false;
  }
}

/**
 * Called right after the shared failure toast was shown for `threadId`: when the thread is held
 * by unverifiable remote shell records, the toast gains the forget-and-delete action.
 */
export async function offerForgetRemoteShell(input: {
  readonly threadId: ThreadId;
  readonly retryDelete: () => Promise<void>;
}): Promise<void> {
  toastThreadId = input.threadId;
  const api = readNativeApi();
  const inspect = api?.terminal?.retainedShellOwners;
  if (!api || !inspect) return;
  const owners = await inspect({ threadId: input.threadId }).catch(() => null);
  // Another failure may have taken over the toast while the records were being read.
  if (!owners || owners.count === 0 || toastThreadId !== input.threadId) return;
  toastManager.update(THREAD_DELETION_FAILED_TOAST_ID, {
    actionProps: {
      children: FORGET_REMOTE_SHELL_ACTION_LABEL,
      onClick: () => {
        void forgetRemoteShellAndDelete({ api, ...input, hosts: owners.hosts });
      },
    },
  });
}

/** Shows one toast for a batch's undone deletions a person asked for. */
export function notifyFailedThreadDeletions(input: {
  readonly events: ReadonlyArray<OrchestrationEvent>;
  readonly failedThreadIds: ReadonlyArray<ThreadId>;
  readonly alreadyNotifiedThreadIds: ReadonlySet<ThreadId>;
}): void {
  const failures = getBatchFailedThreadDeletions(input);
  const toast = getFailedThreadDeletionToast(failures);
  if (!toast) return;
  toastManager.add(toast);
  const [only] = failures;
  if (failures.length === 1 && only) {
    void offerForgetRemoteShell({
      threadId: only.threadId,
      retryDelete: () => retryThreadDeletion(only.threadId),
    });
  } else {
    toastThreadId = null;
  }
}
