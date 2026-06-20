import { AutomationId, ProjectId, ThreadId } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import { listAllAutomations, listAutomationThreadIds } from "./automationDirectory";

describe("listAllAutomations", () => {
  it("loads every automation from the server in one request", async () => {
    const listAllAutomationsRpc = vi.fn().mockResolvedValue({
      automations: [
        {
          automationId: AutomationId.makeUnsafe("auto-1"),
          projectId: ProjectId.makeUnsafe("project-1"),
          targetThreadId: ThreadId.makeUnsafe("thread-1"),
          title: "Daily summary",
          prompt: "Summarize work",
          scheduleKind: "custom" as const,
          scheduleLabel: "Every day at 9:00 AM",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          runAt: null,
          nextRunAt: "2026-06-17T09:00:00.000Z",
          pausedAt: null,
          completedAt: null,
          deletedAt: null,
          createdAt: "2026-06-16T09:00:00.000Z",
          updatedAt: "2026-06-16T09:00:00.000Z",
        },
      ],
    });

    await expect(
      listAllAutomations({ listAllAutomations: listAllAutomationsRpc }),
    ).resolves.toHaveLength(1);
    expect(listAllAutomationsRpc).toHaveBeenCalledWith({});
  });

  it("collects target thread ids for sidebar labeling", async () => {
    const listAllAutomationsRpc = vi.fn().mockResolvedValue({
      automations: [
        {
          automationId: AutomationId.makeUnsafe("auto-1"),
          projectId: ProjectId.makeUnsafe("project-1"),
          targetThreadId: ThreadId.makeUnsafe("thread-1"),
          title: "Daily summary",
          prompt: "Summarize work",
          scheduleKind: "custom" as const,
          scheduleLabel: "Every day at 9:00 AM",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          runAt: null,
          nextRunAt: "2026-06-17T09:00:00.000Z",
          pausedAt: null,
          completedAt: null,
          deletedAt: null,
          createdAt: "2026-06-16T09:00:00.000Z",
          updatedAt: "2026-06-16T09:00:00.000Z",
        },
        {
          automationId: AutomationId.makeUnsafe("auto-2"),
          projectId: ProjectId.makeUnsafe("project-2"),
          targetThreadId: ThreadId.makeUnsafe("thread-2"),
          title: "Weekly summary",
          prompt: "Summarize week",
          scheduleKind: "custom" as const,
          scheduleLabel: "Every Monday at 9:00 AM",
          cronExpression: "0 9 * * 1",
          timezone: "UTC",
          runAt: null,
          nextRunAt: "2026-06-17T09:00:00.000Z",
          pausedAt: null,
          completedAt: null,
          deletedAt: null,
          createdAt: "2026-06-16T09:00:00.000Z",
          updatedAt: "2026-06-16T09:00:00.000Z",
        },
      ],
    });

    const threadIds = await listAutomationThreadIds({ listAllAutomations: listAllAutomationsRpc });

    expect(threadIds.has(ThreadId.makeUnsafe("thread-1"))).toBe(true);
    expect(threadIds.has(ThreadId.makeUnsafe("thread-2"))).toBe(true);
    expect(threadIds.size).toBe(2);
  });
});
