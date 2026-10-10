import type { ProviderSendTurnInput } from "@bigbud/contracts/orchestration/provider.ts";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
} from "@bigbud/contracts/orchestration/orchestration.provider.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";

/** Reject stale/unsupported/bounded input before either model mutation or prompt admission. */
export function validateV2TurnInput(
  session: V2RuntimeSession,
  input: ProviderSendTurnInput,
): string {
  const text = input.input ?? "";
  if (
    (!text.trim() && !input.attachments?.length) ||
    text.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS ||
    (input.attachments?.length ?? 0) > PROVIDER_SEND_TURN_MAX_ATTACHMENTS
  )
    throw new Error("V2 prompt bounds rejected.");
  if (input.interactionMode && input.interactionMode !== "default")
    throw new Error("V2 non-default interaction mode is not verified.");
  if (input.sessionEpoch !== undefined && input.sessionEpoch !== session.epoch)
    throw new Error("V2 epoch fence rejected.");
  return text;
}
