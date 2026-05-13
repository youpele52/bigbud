/**
 * Event handler dispatch — maps every Codex provider notification/request method
 * to zero-or-more canonical ProviderRuntimeEvents.
 *
 * @module CodexAdapter.stream.handlers
 */
import { type ProviderEvent, type ProviderRuntimeEvent, ThreadId } from "@bigbud/contracts";

import { mapItemLifecycle, runtimeEventBase } from "./Adapter.stream.base.ts";

import {
  handleSessionConnecting,
  handleSessionExited,
  handleSessionReady,
  handleSessionStarted,
  handleWindowsSandboxSetupCompleted,
} from "./Adapter.stream.handlers.session.ts";

import {
  handleThreadNameUpdated,
  handleThreadRealtimeAudioDelta,
  handleThreadRealtimeClosed,
  handleThreadRealtimeError,
  handleThreadRealtimeItemAdded,
  handleThreadRealtimeStarted,
  handleThreadRealtimeTranscript,
  handleThreadStarted,
  handleThreadStateChanged,
  handleThreadTokenUsageUpdated,
} from "./Adapter.stream.handlers.thread.ts";

import {
  handleContentDelta,
  handleItemCompleted,
  handleItemPlanDelta,
  handleItemStarted,
  handleMcpToolCallProgress,
  handleTurnAborted,
  handleTurnCompleted,
  handleTurnDiffUpdated,
  handleTurnPlanUpdated,
  handleTurnStarted,
} from "./Adapter.stream.handlers.turn.ts";

import {
  handleCodexAgentReasoning,
  handleCodexReasoningContentDelta,
  handleCodexTaskComplete,
  handleCodexTaskStarted,
  handleRequestOpened,
  handleRequestResolved,
  handleServerRequestResolved,
  handleUserInputAnswered,
} from "./Adapter.stream.handlers.request.ts";

import {
  handleAccountRateLimitsUpdated,
  handleAccountUpdated,
  handleConfigWarning,
  handleDeprecationNotice,
  handleMcpOauthCompleted,
  handleModelRerouted,
  handleProcessStderr,
  handleRuntimeError,
  handleWindowsWorldWritableWarning,
} from "./Adapter.stream.handlers.misc.ts";

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

export function mapToRuntimeEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  if (event.kind === "error") {
    if (!event.message) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "runtime.error",
        payload: {
          message: event.message,
          class: "provider_error",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.kind === "request") {
    return handleRequestOpened(event, canonicalThreadId);
  }

  if (event.method === "item/requestApproval/decision" && event.requestId) {
    return handleRequestResolved(event, canonicalThreadId);
  }

  if (event.method === "session/connecting")
    return handleSessionConnecting(event, canonicalThreadId);
  if (event.method === "session/ready") return handleSessionReady(event, canonicalThreadId);
  if (event.method === "session/started") return handleSessionStarted(event, canonicalThreadId);
  if (event.method === "session/exited" || event.method === "session/closed") {
    return handleSessionExited(event, canonicalThreadId);
  }

  if (event.method === "thread/started") return handleThreadStarted(event, canonicalThreadId);
  if (
    event.method === "thread/status/changed" ||
    event.method === "thread/archived" ||
    event.method === "thread/unarchived" ||
    event.method === "thread/closed" ||
    event.method === "thread/compacted"
  ) {
    return handleThreadStateChanged(event, canonicalThreadId);
  }
  if (event.method === "thread/name/updated")
    return handleThreadNameUpdated(event, canonicalThreadId);
  if (event.method === "thread/tokenUsage/updated") {
    return handleThreadTokenUsageUpdated(event, canonicalThreadId);
  }

  if (event.method === "turn/started") return handleTurnStarted(event, canonicalThreadId);
  if (event.method === "turn/completed") return handleTurnCompleted(event, canonicalThreadId);
  if (event.method === "turn/aborted") return handleTurnAborted(event, canonicalThreadId);
  if (event.method === "turn/plan/updated") return handleTurnPlanUpdated(event, canonicalThreadId);
  if (event.method === "turn/diff/updated") return handleTurnDiffUpdated(event, canonicalThreadId);

  if (event.method === "item/started") return handleItemStarted(event, canonicalThreadId);
  if (event.method === "item/completed") return handleItemCompleted(event, canonicalThreadId);
  if (
    event.method === "item/reasoning/summaryPartAdded" ||
    event.method === "item/commandExecution/terminalInteraction" ||
    event.method === "item/fileChange/patchUpdated"
  ) {
    const updated = mapItemLifecycle(event, canonicalThreadId, "item.updated");
    return updated ? [updated] : [];
  }
  if (event.method === "item/plan/delta") return handleItemPlanDelta(event, canonicalThreadId);
  if (
    event.method === "item/agentMessage/delta" ||
    event.method === "item/commandExecution/outputDelta" ||
    event.method === "item/fileChange/outputDelta" ||
    event.method === "item/reasoning/summaryTextDelta" ||
    event.method === "item/reasoning/textDelta"
  ) {
    return handleContentDelta(event, canonicalThreadId);
  }
  if (event.method === "item/mcpToolCall/progress") {
    return handleMcpToolCallProgress(event, canonicalThreadId);
  }

  if (event.method === "serverRequest/resolved") {
    return handleServerRequestResolved(event, canonicalThreadId);
  }
  if (event.method === "item/tool/requestUserInput/answered") {
    return handleUserInputAnswered(event, canonicalThreadId);
  }

  if (event.method === "codex/event/task_started") {
    return handleCodexTaskStarted(event, canonicalThreadId);
  }
  if (event.method === "codex/event/task_complete") {
    return handleCodexTaskComplete(event, canonicalThreadId);
  }
  if (event.method === "codex/event/agent_reasoning") {
    return handleCodexAgentReasoning(event, canonicalThreadId);
  }
  if (event.method === "codex/event/reasoning_content_delta") {
    return handleCodexReasoningContentDelta(event, canonicalThreadId);
  }

  if (event.method === "model/rerouted") return handleModelRerouted(event, canonicalThreadId);
  if (event.method === "deprecationNotice")
    return handleDeprecationNotice(event, canonicalThreadId);
  if (event.method === "configWarning") return handleConfigWarning(event, canonicalThreadId);
  if (event.method === "account/updated") return handleAccountUpdated(event, canonicalThreadId);
  if (event.method === "account/rateLimits/updated") {
    return handleAccountRateLimitsUpdated(event, canonicalThreadId);
  }
  if (event.method === "mcpServer/oauthLogin/completed") {
    return handleMcpOauthCompleted(event, canonicalThreadId);
  }

  if (event.method === "thread/realtime/started") {
    return handleThreadRealtimeStarted(event, canonicalThreadId);
  }
  if (event.method === "thread/realtime/itemAdded") {
    return handleThreadRealtimeItemAdded(event, canonicalThreadId);
  }
  if (
    event.method === "thread/realtime/transcript/delta" ||
    event.method === "thread/realtime/transcript/done" ||
    event.method === "thread/realtime/transcriptUpdated"
  ) {
    return handleThreadRealtimeTranscript(event, canonicalThreadId);
  }
  if (event.method === "thread/realtime/outputAudio/delta") {
    return handleThreadRealtimeAudioDelta(event, canonicalThreadId);
  }
  if (event.method === "thread/realtime/error") {
    return handleThreadRealtimeError(event, canonicalThreadId);
  }
  if (event.method === "thread/realtime/closed") {
    return handleThreadRealtimeClosed(event, canonicalThreadId);
  }

  if (event.method === "error") return handleRuntimeError(event, canonicalThreadId);
  if (event.method === "process/stderr") return handleProcessStderr(event, canonicalThreadId);
  if (event.method === "windows/worldWritableWarning") {
    return handleWindowsWorldWritableWarning(event, canonicalThreadId);
  }
  if (event.method === "windowsSandbox/setupCompleted") {
    return handleWindowsSandboxSetupCompleted(event, canonicalThreadId);
  }

  return [];
}
