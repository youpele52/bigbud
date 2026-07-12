import type { Thread } from "~/models/types";

type ThreadPurpose = Pick<Thread, "purpose">;

export function isSidecarThread(thread: ThreadPurpose): boolean {
  return thread.purpose === "side-chat";
}

export function isVisibleThread(thread: ThreadPurpose): boolean {
  return !isSidecarThread(thread);
}
