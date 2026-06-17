import type { AutomationSchedule, RuntimeMode, ServerDiscoveredSkill } from "@bigbud/contracts";
import type { ChatMessage } from "~/models/types";

import { buildSkillMentionPrompt } from "./skillMentions";

export const AUTOMATION_SKILL_NAME = "automation";
export const AUTOMATION_SKILL_PROMPT = `${buildSkillMentionPrompt(AUTOMATION_SKILL_NAME)} `;
export const AUTOMATION_AUTHORING_RUNTIME_MODE: RuntimeMode = "approval-required";

const AUTOMATION_REQUEST_TAG_REGEX = /<automation_request>\s*([\s\S]*?)\s*<\/automation_request>/i;

export interface AutomationSkillRequest {
  readonly title: string;
  readonly prompt: string;
  readonly scheduleKind: "custom" | "once";
  readonly scheduleLabel: string;
  readonly cronExpression: string;
  readonly timezone: string;
  readonly runAt?: string | null;
  readonly projectTitle?: string;
}

export function getDeviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function formatAutomationContextDateTime(date: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  });
  const parts = new Map(
    formatter.formatToParts(date).map((part) => [part.type, part.value] as const),
  );

  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")} ${parts.get("hour")}:${parts.get("minute")}`;
}

export function buildAutomationSkillDispatchPrompt(input: {
  readonly rawPrompt: string;
  readonly defaultProjectName: string;
  readonly deviceTimeZone: string;
  readonly existingAutomation?: {
    readonly projectName: string;
    readonly prompt: string;
    readonly scheduleLabel: string;
    readonly timezone: string;
    readonly title: string;
  };
  readonly now?: Date;
}): string {
  if (!input.rawPrompt.startsWith(AUTOMATION_SKILL_PROMPT)) {
    return input.rawPrompt;
  }

  const userRequest = input.rawPrompt.slice(AUTOMATION_SKILL_PROMPT.length).trim();
  const currentLocalDateTime = formatAutomationContextDateTime(
    input.now ?? new Date(),
    input.deviceTimeZone,
  );

  return [
    AUTOMATION_SKILL_PROMPT.trimEnd(),
    "",
    "Automation authoring rules:",
    "- Do not perform the requested task now.",
    "- Do not inspect files, run commands, or produce the requested result during setup.",
    "- Only collect scheduling details and emit exactly one <automation_request> block.",
    "",
    "Default automation context:",
    `- Current local date/time: ${currentLocalDateTime} (${input.deviceTimeZone})`,
    `- Device local timezone: ${input.deviceTimeZone}`,
    `- Default project: ${input.defaultProjectName}`,
    "- Default frequency when omitted: once",
    ...(input.existingAutomation
      ? [
          "",
          "Existing automation:",
          `- Title: ${input.existingAutomation.title}`,
          `- Project: ${input.existingAutomation.projectName}`,
          `- Schedule: ${input.existingAutomation.scheduleLabel}`,
          `- Timezone: ${input.existingAutomation.timezone}`,
          `- Current prompt: ${input.existingAutomation.prompt}`,
          "- Preserve unchanged intent unless the user explicitly asks to change it.",
        ]
      : []),
    "",
    "User request:",
    userRequest.length > 0 ? userRequest : "Create a new automation.",
  ].join("\n");
}

export function validateAutomationSkillRequest(
  request: AutomationSkillRequest,
  now: Date = new Date(),
): string | null {
  if (request.scheduleKind === "once") {
    if (!request.runAt) {
      return "One-time automations must include a scheduled run time.";
    }

    const runAtMs = Date.parse(request.runAt);
    if (Number.isNaN(runAtMs)) {
      return "The scheduled run time is invalid.";
    }

    if (runAtMs <= now.getTime()) {
      return "The scheduled run time must be in the future.";
    }
  }

  return null;
}

export function extractAutomationRequest(text: string): AutomationSkillRequest | null {
  const match = AUTOMATION_REQUEST_TAG_REGEX.exec(text);
  if (!match?.[1]) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[1]) as AutomationSkillRequest;
    if (
      typeof parsed.title !== "string" ||
      typeof parsed.prompt !== "string" ||
      typeof parsed.scheduleKind !== "string" ||
      typeof parsed.scheduleLabel !== "string" ||
      typeof parsed.cronExpression !== "string" ||
      typeof parsed.timezone !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function extractAutomationRequestPayload(text: string): string | null {
  const match = AUTOMATION_REQUEST_TAG_REGEX.exec(text);
  return match?.[1]?.trim() ?? null;
}

export function stripAutomationRequestTag(text: string): string {
  return text.replace(AUTOMATION_REQUEST_TAG_REGEX, "").trim();
}

export function deriveAutomationAssistantDisplayState(text: string): {
  readonly request: AutomationSkillRequest | null;
  readonly requestPayload: string | null;
  readonly visibleText: string;
} {
  return {
    request: extractAutomationRequest(text),
    requestPayload: extractAutomationRequestPayload(text),
    visibleText: stripAutomationRequestTag(text),
  };
}

export function resolveAutomationStatus(
  automation: AutomationSchedule,
): "Active" | "Completed" | "Paused" {
  if (automation.completedAt !== null) {
    return "Completed";
  }
  if (automation.pausedAt !== null) {
    return "Paused";
  }
  return "Active";
}

export function formatAutomationDateTime(value: string | null): string {
  if (!value) {
    return "Never";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function formatAutomationListTimeLabel(
  automation: Pick<
    AutomationSchedule,
    "completedAt" | "nextRunAt" | "pausedAt" | "scheduleKind" | "scheduleLabel"
  >,
): string {
  const hasUpcomingRun =
    automation.nextRunAt !== null &&
    automation.completedAt === null &&
    automation.pausedAt === null;

  if (hasUpcomingRun) {
    return formatAutomationDateTime(automation.nextRunAt);
  }

  if (automation.scheduleKind === "once") {
    return "Once";
  }

  return automation.scheduleLabel;
}

function automationScheduleRank(automation: Pick<AutomationSchedule, "completedAt" | "pausedAt">) {
  if (automation.completedAt === null && automation.pausedAt === null) {
    return 0;
  }
  if (automation.completedAt === null) {
    return 1;
  }
  return 2;
}

export function compareAutomationSchedules(
  left: Pick<AutomationSchedule, "completedAt" | "createdAt" | "nextRunAt" | "pausedAt">,
  right: Pick<AutomationSchedule, "completedAt" | "createdAt" | "nextRunAt" | "pausedAt">,
): number {
  const rankDifference = automationScheduleRank(left) - automationScheduleRank(right);
  if (rankDifference !== 0) {
    return rankDifference;
  }

  const leftTimestamp =
    left.completedAt ?? left.nextRunAt ?? left.createdAt ?? new Date(0).toISOString();
  const rightTimestamp =
    right.completedAt ?? right.nextRunAt ?? right.createdAt ?? new Date(0).toISOString();

  if (automationScheduleRank(left) === 2) {
    return Date.parse(rightTimestamp) - Date.parse(leftTimestamp);
  }

  return Date.parse(leftTimestamp) - Date.parse(rightTimestamp);
}

export function findAutomationSkill(
  skills: ReadonlyArray<ServerDiscoveredSkill>,
): ServerDiscoveredSkill | null {
  return skills.find((skill) => skill.name === AUTOMATION_SKILL_NAME) ?? null;
}

export function findLatestAutomationAssistantMessage(
  messages: ReadonlyArray<ChatMessage>,
  requestMessageId: string | null,
): ChatMessage | null {
  if (requestMessageId === null) {
    return null;
  }

  const requestIndex = messages.findIndex((message) => message.id === requestMessageId);
  if (requestIndex < 0) {
    return null;
  }

  return (
    messages
      .slice(requestIndex + 1)
      .findLast((message) => message.role === "assistant" && !message.streaming && message.text) ??
    null
  );
}
