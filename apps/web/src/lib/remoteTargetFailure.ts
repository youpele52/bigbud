import {
  TurnStartRemoteTargetFailure,
  type TurnStartRemoteTargetFailure as TurnStartRemoteTargetFailureType,
} from "@bigbud/contracts/orchestration/orchestration.turnFailure.ts";
import { Option, Schema } from "effect";

import { REMOTE_EXECUTION_TARGET_DISCONNECTED_MESSAGE } from "../stores/remoteAccess/remoteAccess.store";
import { getSshAuthPrompt } from "./ssh";

const decodeRemoteTarget = Schema.decodeUnknownOption(TurnStartRemoteTargetFailure);

/** Where an SSH auth message can start inside a longer provider failure detail. */
const SSH_AUTH_MESSAGE_STARTS = [
  "SSH password is required for ",
  "SSH key '",
  "SSH host trust is required: ",
  "Incorrect password for ",
] as const;

/** The server's `remoteTarget` marker on a `provider.turn.start.failed` payload, if valid. */
export function decodeRemoteTargetFailure(
  payload: unknown,
): TurnStartRemoteTargetFailureType | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const marker = (payload as { readonly remoteTarget?: unknown }).remoteTarget;
  return marker === undefined ? undefined : Option.getOrUndefined(decodeRemoteTarget(marker));
}

/**
 * The SSH auth message embedded in a failure detail (adapters may prefix it), so the existing
 * `getSshAuthPrompt` parsers and `resolveRemoteExecutionFailureStatus` can read it.
 */
export function extractRemoteTargetMessage(text: string | null | undefined): string | null {
  if (!text) return null;
  if (text.includes(REMOTE_EXECUTION_TARGET_DISCONNECTED_MESSAGE)) {
    return REMOTE_EXECUTION_TARGET_DISCONNECTED_MESSAGE;
  }
  for (const start of SSH_AUTH_MESSAGE_STARTS) {
    const index = text.indexOf(start);
    if (index < 0) continue;
    const message = text.slice(index).trim();
    if (getSshAuthPrompt(message)) return message;
  }
  return null;
}

/** Legacy rows (no marker): infers the marker from the failure text. */
export function inferRemoteTargetFailure(
  text: string | null | undefined,
): TurnStartRemoteTargetFailureType | undefined {
  const message = extractRemoteTargetMessage(text);
  if (!message) return undefined;
  if (message === REMOTE_EXECUTION_TARGET_DISCONNECTED_MESSAGE) return { reason: "disconnected" };
  const prompt = getSshAuthPrompt(message);
  return prompt ? { reason: "auth-required", authMode: prompt.mode } : undefined;
}

/** True for thread error text that the remote-target notice presents instead. */
export function isRemoteTargetErrorText(text: string | null | undefined): boolean {
  return extractRemoteTargetMessage(text) !== null;
}
