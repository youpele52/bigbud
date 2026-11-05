import {
  THREAD_ORGANIZATION_STATES,
  THREAD_SNOOZE_MAX_MINUTES,
  THREAD_SNOOZE_MIN_MINUTES,
} from "@bigbud/contracts/orchestration/orchestration.organization.ts";

import {
  MOVE_THREAD_TOOL_DESCRIPTION,
  SNOOZE_THREAD_TOOL_DESCRIPTION,
} from "./threadOrganizationTool.shared.ts";

/**
 * Pi `move_thread` and `snooze_thread` definitions (`moveThreadTool`, `snoozeThreadTool`). They
 * rely on the bridge's `callOrchestrationTool`, `resolveCurrentThreadId`, and `textResult`.
 */
export function renderPiOrganizationToolsSource(): string {
  const states = THREAD_ORGANIZATION_STATES.map(
    (state) => `Type.Literal(${JSON.stringify(state)})`,
  );
  return [
    "const moveThreadTool = defineTool({",
    '  name: "move_thread",',
    '  label: "move_thread",',
    `  description: ${JSON.stringify(MOVE_THREAD_TOOL_DESCRIPTION)},`,
    "  parameters: Type.Object({",
    `    state: Type.Union([${states.join(", ")}], { description: "Destination Inyosira state" }),`,
    '    targetThreadId: Type.Optional(Type.String({ description: "Canonical target thread ID; omit for the current thread" })),',
    "  }),",
    "  async execute(toolCallId, { state, targetThreadId }) {",
    "    const result = await callOrchestrationTool({",
    "      action: 'move',",
    "      threadId: resolveCurrentThreadId(),",
    "      organizationState: String(state ?? ''),",
    "      ...(targetThreadId !== undefined ? { targetThreadId } : {}),",
    "      invocationId: toolCallId,",
    "    });",
    "    return textResult(JSON.stringify(result.result ?? {}, null, 2));",
    "  },",
    "});",
    "",
    "const snoozeThreadTool = defineTool({",
    '  name: "snooze_thread",',
    '  label: "snooze_thread",',
    `  description: ${JSON.stringify(SNOOZE_THREAD_TOOL_DESCRIPTION)},`,
    "  parameters: Type.Object({",
    `    minutes: Type.Integer({ minimum: ${THREAD_SNOOZE_MIN_MINUTES}, maximum: ${THREAD_SNOOZE_MAX_MINUTES}, description: "Snooze duration in whole minutes" }),`,
    '    targetThreadId: Type.Optional(Type.String({ description: "Canonical target thread ID; omit for the current thread" })),',
    "  }),",
    "  async execute(toolCallId, { minutes, targetThreadId }) {",
    "    const result = await callOrchestrationTool({",
    "      action: 'snooze',",
    "      threadId: resolveCurrentThreadId(),",
    "      durationMinutes: Number(minutes),",
    "      ...(targetThreadId !== undefined ? { targetThreadId } : {}),",
    "      invocationId: toolCallId,",
    "    });",
    "    return textResult(JSON.stringify(result.result ?? {}, null, 2));",
    "  },",
    "});",
  ].join("\n");
}
