import { type AutomationSchedule, type ProjectId, type ThreadId } from "@bigbud/contracts";

import { compareAutomationSchedules } from "~/lib/automation";

export interface AutomationProjectOption {
  readonly id: ProjectId;
  readonly isChats: boolean;
  readonly label: string;
}

interface AutomationListServerApi {
  readonly listAllAutomations: (input?: Record<string, never>) => Promise<{
    readonly automations: ReadonlyArray<AutomationSchedule>;
  }>;
}

export function buildAutomationProjectLabelById(
  projectOptions: ReadonlyArray<AutomationProjectOption>,
) {
  return new Map(projectOptions.map((option) => [option.id, option.label] as const));
}

export async function listAllAutomations(
  api: AutomationListServerApi,
): Promise<ReadonlyArray<AutomationSchedule>> {
  const { automations } = await api.listAllAutomations({});
  return [...automations].toSorted(compareAutomationSchedules);
}

export async function listAutomationThreadIds(
  api: AutomationListServerApi,
): Promise<ReadonlySet<ThreadId>> {
  const automations = await listAllAutomations(api);
  return new Set(
    automations
      .map((automation) => automation.targetThreadId)
      .filter((threadId): threadId is ThreadId => threadId != null),
  );
}
