import type { NativeApi } from "@bigbud/contracts";
import { readNativeApi } from "../../../rpc/nativeApi";
import { requestCopilotSetup } from "../../../hooks/useCopilotRuntime";
import { toastManager } from "../../ui/toast";

/** Recheck before selection/send, before any composer reset, thread creation, or turn dispatch. */
export async function ensureCopilotRuntimeForChat(
  api: NativeApi | undefined = readNativeApi() ?? undefined,
): Promise<boolean> {
  if (!api?.server.copilotRuntime) return true; // Compatibility with older connected servers.
  try {
    const status = await api.server.copilotRuntime({ action: "status" });
    if (status.available) return true;
    requestCopilotSetup();
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Could not check Copilot runtime",
      description: error instanceof Error ? error.message : String(error),
    });
  }
  return false;
}
