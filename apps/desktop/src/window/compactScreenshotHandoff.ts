import type { CompactChatScreenshot } from "@bigbud/contracts/server/ipc.desktopScreenshot.ts";

type PendingScreenshot = Omit<CompactChatScreenshot, "threadId"> & { threadId: string | null };

/** One unacknowledged image bounds memory while a renderer loads or reconnects. */
export class CompactScreenshotHandoff {
  #pending: PendingScreenshot | null = null;
  #selectedThreadId: string | null = null;

  get pending(): boolean {
    return this.#pending !== null;
  }

  get selectedThreadId(): string | null {
    return this.#selectedThreadId;
  }

  put(screenshot: PendingScreenshot): void {
    if (this.#pending) throw new Error("A screenshot is already waiting for the floating chat.");
    this.#pending = screenshot;
  }

  read(threadId: string): CompactChatScreenshot | null {
    this.#selectedThreadId = threadId;
    if (!this.#pending) return null;
    this.#pending.threadId ??= threadId;
    return { ...this.#pending, threadId: this.#pending.threadId };
  }

  acknowledge(id: string): boolean {
    if (this.#pending?.id !== id) return false;
    this.#pending = null;
    return true;
  }

  clear(): void {
    this.#pending = null;
    this.#selectedThreadId = null;
  }
}
