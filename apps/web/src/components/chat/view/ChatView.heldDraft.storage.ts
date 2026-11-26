import type { ClientOrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import type { OrchestrationQueuedPrompt } from "@bigbud/contracts/orchestration/orchestration.thread.ts";

export type HeldClaim = Extract<ClientOrchestrationCommand, { type: "thread.queued-prompt.claim" }>;
export type HeldRecovery = Extract<
  ClientOrchestrationCommand,
  { type: "thread.queued-prompt.recovered" }
>;

export interface HeldDraft {
  readonly claim: HeldClaim;
  readonly prompt: OrchestrationQueuedPrompt;
  readonly claimed: boolean;
  readonly recovery?: HeldRecovery;
}

const STORE = "held-drafts";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("bigbud-held-drafts", 1);
    request.addEventListener("upgradeneeded", () => request.result.createObjectStore(STORE));
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

/** Compare and update inside one transaction so two windows cannot mint competing sends. */
export async function heldDraftTransaction(
  key: string,
  update?: (current: HeldDraft | undefined) => HeldDraft | undefined,
): Promise<HeldDraft | undefined> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = update
        ? database.transaction(STORE, "readwrite", { durability: "strict" })
        : database.transaction(STORE, "readonly");
      if (update && transaction.durability !== "strict") {
        transaction.abort();
        reject(new Error("Strict recovered draft storage is unavailable in this window."));
        return;
      }
      const store = transaction.objectStore(STORE);
      const read = store.get(key);
      let next: HeldDraft | undefined;
      read.addEventListener("success", () => {
        const current = read.result as HeldDraft | undefined;
        next = update ? update(current) : current;
        if (update && next !== current) {
          if (next) store.put(next, key);
          else store.delete(key);
        }
      });
      transaction.addEventListener("complete", () => resolve(next));
      transaction.addEventListener("abort", () =>
        reject(transaction.error ?? new Error("Draft storage failed.")),
      );
    });
  } finally {
    database.close();
  }
}
