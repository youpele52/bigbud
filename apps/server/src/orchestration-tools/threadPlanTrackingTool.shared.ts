import { type ProviderRuntimeEvent, type TurnId } from "@bigbud/contracts";

import { normalizePlanStepStatus } from "../provider/acp/AcpRuntimeModel.toolCalls.ts";

type TurnPlanUpdatedPayload = Extract<
  ProviderRuntimeEvent,
  { type: "turn.plan.updated" }
>["payload"];

export const BIGBUD_PLAN_TRACKING_TOOL_NAME = "update_plan" as const;

export const BIGBUD_PLAN_TRACKING_TOOL_INSTRUCTION =
  "When the `update_plan` tool is available, call it as soon as you start a multi-step task, update it after each meaningful plan change or step-status change, and always send the full current plan with step statuses. Do not wait until the end of the turn.";

export const BIGBUD_PLAN_TRACKING_TOOL_DESCRIPTION =
  "Update BigBud's floating Tasks/Plan card for the current turn. Use it early for multi-step work, update it whenever you revise the plan or change a step status, and always send the full current plan with step statuses.";

export const BIGBUD_PLAN_TRACKING_TOOL_SUCCESS_MESSAGE = "Updated the current Tasks/Plan card.";

export const BIGBUD_PLAN_TRACKING_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    explanation: {
      type: "string",
      description: "Optional short note about the current plan.",
    },
    plan: {
      type: "array",
      description: "The full current plan for this turn.",
      items: {
        type: "object",
        properties: {
          step: {
            type: "string",
            description: "Plan step label.",
          },
          status: {
            type: "string",
            enum: ["pending", "inProgress", "completed"],
            description: "Current step status.",
          },
        },
        required: ["step", "status"],
        additionalProperties: false,
      },
    },
  },
  required: ["plan"],
  additionalProperties: false,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function isBigbudPlanTrackingToolName(toolName: string): boolean {
  return toolName === BIGBUD_PLAN_TRACKING_TOOL_NAME;
}

export function normalizeBigbudPlanTrackingPayload(
  input: unknown,
): TurnPlanUpdatedPayload | undefined {
  if (!isRecord(input) || !Array.isArray(input.plan)) {
    return undefined;
  }

  const plan = input.plan.filter(isRecord).map((entry) => ({
    step: normalizeString(entry.step) ?? normalizeString(entry.content) ?? "Task",
    status: normalizePlanStepStatus(entry.status),
  }));

  const explanation = normalizeString(input.explanation);
  return {
    ...(explanation ? { explanation } : {}),
    plan,
  };
}

export function buildBigbudPlanTrackingFingerprint(
  turnId: TurnId | undefined,
  payload: TurnPlanUpdatedPayload,
): string {
  return `${turnId ?? "no-turn"}:${JSON.stringify(payload)}`;
}
