import type {
  ChatAttachment,
  OrchestrationThread,
  ProviderKind,
  ProviderSession,
} from "@bigbud/contracts";

import { FRESH_REPLAY_EXCLUDED_PROVIDERS } from "./ProviderCommandReactorSessionOps.recovery.turnStart.ts";

/**
 * Whether the provider context must be rebuilt from the bigbud transcript. Attachments do not
 * prevent the rebuild: they are forwarded to the provider separately (plan D14).
 *
 * Providers whose "fresh" session is not isolated (gate G2a) resume their own native history
 * instead, so an inactive thread of theirs is restarted from its saved binding, never replayed.
 * A bootstrap source or a fork's copied transcript still seeds a thread with no native history yet.
 */
export function shouldRebuildProviderContextFromTranscript(input: {
  readonly provider: ProviderKind;
  readonly thread: OrchestrationThread;
  readonly bootstrapThread: OrchestrationThread | null;
  readonly activeSession: ProviderSession | undefined;
  readonly messageText: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}): boolean {
  if (input.bootstrapThread) {
    return input.bootstrapThread.messages.length > 0;
  }
  if (input.activeSession) {
    return false;
  }
  if (FRESH_REPLAY_EXCLUDED_PROVIDERS.has(input.provider) && hasNativeHistory(input.thread)) {
    return false;
  }
  return input.thread.messages.length > 1;
}

/**
 * Only a fork starts on an empty native session: its copied messages carry `turnId: null`, so its
 * own first reply marks native history. (The session is projected "starting" before any send, so
 * it cannot tell.) A fork whose replayed turn was admitted but never replied replays again.
 */
function hasNativeHistory(thread: OrchestrationThread): boolean {
  return (
    thread.forkOrigin === undefined ||
    thread.messages.some((message) => message.role === "assistant" && message.turnId !== null)
  );
}
