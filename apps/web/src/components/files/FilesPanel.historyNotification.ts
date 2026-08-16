import { toastManager } from "../ui/toast";

export function notifyRemovedFileHistoryEntries(count: number): void {
  if (count === 0) return;
  toastManager.add({
    type: "info",
    title: `${count} missing file${count === 1 ? "" : "s"} removed from history.`,
  });
}
