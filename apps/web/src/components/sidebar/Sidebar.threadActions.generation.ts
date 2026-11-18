import { EventId, type ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { readNativeApi } from "../../rpc/nativeApi";
import { randomUUID } from "../../lib/utils";
import { toastManager } from "../ui/toast";

const pending = new Set<ThreadId>();

/** Separate user-authorized budget; never silently converts ordinary Retry into recovery. */
export async function requestNewThreadTitle(threadId: ThreadId) {
  const api = readNativeApi();
  if (!api || pending.has(threadId)) return;
  pending.add(threadId);
  try {
    const confirmed = await api.dialogs.confirm(
      "Generate a new title? This authorizes a separate paid request. Historical generation may still be unresolved, so this could incur duplicate cost. Old reservations are preserved, and known unsettled work will still block generation.",
    );
    if (!confirmed) return;
    await api.server.retryTextGeneration({
      threadId,
      operation: "title",
      newRequestId: EventId.makeUnsafe(randomUUID()),
      acknowledgeHistoricalUncertainty: "authorize-new-budget-with-unresolved-history",
    });
    toastManager.add({
      type: "info",
      title: "Title generation requested",
      description: "Generation remains subject to workspace and unsettled-work safety checks.",
      data: { threadId },
    });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Couldn’t request a new title",
      description: error instanceof Error ? error.message : "Text generation is unavailable.",
      data: { threadId },
    });
  } finally {
    pending.delete(threadId);
  }
}
