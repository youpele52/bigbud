import type {
  SDKAPIRetryMessage,
  SDKBackgroundTasksChangedMessage,
  SDKCommandsChangedMessage,
  SDKElicitationCompleteMessage,
  SDKHookProgressMessage,
  SDKHookResponseMessage,
  SDKHookStartedMessage,
  SDKModelRefusalFallbackMessage,
  SDKModelRefusalNoFallbackMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKTaskUpdatedMessage,
} from "@anthropic-ai/claude-agent-sdk";

const SDK_SESSION_ID = "sdk-session-fixture";
const SDK_UUID = "00000000-0000-4000-8000-000000000001" as const;
const identity = { uuid: SDK_UUID, session_id: SDK_SESSION_ID } as const;

export function sdkTaskStartedFixture(): SDKTaskStartedMessage {
  return {
    type: "system",
    subtype: "task_started",
    task_id: "task-fixture",
    description: "Redacted task",
    ...identity,
  };
}

export function sdkTaskProgressFixture(): SDKTaskProgressMessage {
  return {
    type: "system",
    subtype: "task_progress",
    task_id: "task-fixture",
    description: "Redacted task",
    usage: { total_tokens: 12, tool_uses: 1, duration_ms: 20 },
    ...identity,
  };
}

export function sdkTaskNotificationFixture(): SDKTaskNotificationMessage {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: "task-fixture",
    status: "completed",
    output_file: "redacted",
    summary: "Redacted summary",
    ...identity,
  };
}

export function sdkTaskUpdatedFixture(): SDKTaskUpdatedMessage {
  return {
    type: "system",
    subtype: "task_updated",
    task_id: "task-fixture",
    patch: { status: "running" },
    ...identity,
  };
}

export function sdkBackgroundTasksFixture(): SDKBackgroundTasksChangedMessage {
  return {
    type: "system",
    subtype: "background_tasks_changed",
    tasks: [{ task_id: "task-fixture", task_type: "agent", description: "Redacted task" }],
    ...identity,
  };
}

export function sdkHookStartedFixture(): SDKHookStartedMessage {
  return {
    type: "system",
    subtype: "hook_started",
    hook_id: "hook-fixture",
    hook_name: "PreToolUse",
    hook_event: "PreToolUse",
    ...identity,
  };
}

export function sdkHookProgressFixture(): SDKHookProgressMessage {
  return {
    type: "system",
    subtype: "hook_progress",
    hook_id: "hook-fixture",
    hook_name: "PostToolUse",
    hook_event: "PostToolUse",
    output: "redacted",
    stdout: "",
    stderr: "",
    ...identity,
  };
}

export function sdkHookResponseFixture(): SDKHookResponseMessage {
  return {
    type: "system",
    subtype: "hook_response",
    hook_id: "hook-fixture",
    hook_name: "PostToolUse",
    hook_event: "PostToolUse",
    output: "redacted",
    stdout: "",
    stderr: "",
    outcome: "success",
    ...identity,
  };
}

export function sdkApiRetryFixture(): SDKAPIRetryMessage {
  return {
    type: "system",
    subtype: "api_retry",
    attempt: 1,
    max_retries: 3,
    retry_delay_ms: 100,
    error_status: 429,
    error: "rate_limit",
    ...identity,
  };
}

export function sdkModelRefusalFallbackFixture(): SDKModelRefusalFallbackMessage {
  return {
    type: "system",
    subtype: "model_refusal_fallback",
    trigger: "refusal",
    direction: "retry",
    original_model: "model-fixture",
    fallback_model: "fallback-fixture",
    request_id: "request-fixture",
    content: "redacted",
    ...identity,
  };
}

export function sdkModelRefusalNoFallbackFixture(): SDKModelRefusalNoFallbackMessage {
  return {
    type: "system",
    subtype: "model_refusal_no_fallback",
    original_model: "model-fixture",
    request_id: "request-fixture",
    content: "redacted",
    ...identity,
  };
}

export function sdkCommandsChangedFixture(): SDKCommandsChangedMessage {
  return { type: "system", subtype: "commands_changed", commands: [], ...identity };
}

export function sdkElicitationCompleteFixture(): SDKElicitationCompleteMessage {
  return {
    type: "system",
    subtype: "elicitation_complete",
    mcp_server_name: "mcp-fixture",
    elicitation_id: "elicitation-fixture",
    ...identity,
  };
}
