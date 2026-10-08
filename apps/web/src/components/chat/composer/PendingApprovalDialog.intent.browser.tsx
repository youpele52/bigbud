import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { expect, it } from "vitest";
import { EventId, ThreadId, RuntimeRequestId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { approvalRuntimeEventToActivities } from "@bigbud/shared/providerApproval";
import { ApprovalRequestId } from "@bigbud/contracts";
import { derivePendingApprovals } from "../../../logic/session/session.activity.logic";
import { PendingApprovalDialog } from "./PendingApprovalDialog";
const runtimeEventToActivities = (event: ProviderRuntimeEvent) => {
  if (event.type !== "request.opened") throw new Error("expected approval");
  return approvalRuntimeEventToActivities(event, {
    toApprovalRequestId: (value) => (value ? ApprovalRequestId.makeUnsafe(value) : undefined),
    requestKindFromCanonicalRequestType: () => "command",
    truncateDetail: (value) => value.slice(0, 180),
  });
};

it("actual event ingestion retains complete same-root commands/tasks through pending state and inspectable dialog; legacy requests still work", async () => {
  const commands = [
    "printf '" + "a".repeat(240) + " first'",
    "printf '" + "a".repeat(240) + " second'",
  ];
  const intents: Record<string, unknown>[] = commands.map((command) => ({
    action: "shell",
    root: "/workspace",
    command,
  }));
  intents.push({
    action: "orchestration",
    root: "/workspace",
    request: { action: "create_thread", task: "long-task-".repeat(90) },
  });
  for (const [i, intent] of intents.entries()) {
    const content = JSON.stringify(intent, null, 2);
    const event = {
      provider: "opencodeV2",
      eventId: EventId.makeUnsafe(`intent-${i}`),
      threadId: ThreadId.makeUnsafe("parent"),
      requestId: RuntimeRequestId.makeUnsafe(`request-${i}`),
      createdAt: "2026-10-01T00:00:00Z",
      type: "request.opened",
      payload: {
        requestType: "command_execution_approval",
        detail: "abbreviated same root",
        executionIntent: { format: "json", content },
        sessionApprovalAvailable: false,
      },
    } as ProviderRuntimeEvent;
    const approval = derivePendingApprovals(runtimeEventToActivities(event))[0]!;
    expect(approval.executionIntent?.content).toBe(content);
    const view = await render(
      <PendingApprovalDialog
        approval={approval}
        open
        pendingCount={1}
        isResponding={false}
        threadTitle="Parent"
        onOpenChange={() => {}}
        onRespondToApproval={async () => {}}
      />,
    );
    await expect.element(page.getByText(content, { exact: true })).toBeVisible();
    await view.unmount();
  }
  const legacy = derivePendingApprovals(
    runtimeEventToActivities({
      provider: "opencodeV2",
      eventId: EventId.makeUnsafe("legacy"),
      threadId: ThreadId.makeUnsafe("parent"),
      requestId: RuntimeRequestId.makeUnsafe("legacy"),
      createdAt: "2026-10-01T00:00:00Z",
      type: "request.opened",
      payload: {
        requestType: "command_execution_approval",
        detail: "legacy command",
        sessionApprovalLabel: "legacy allow",
        sessionApprovalAvailable: true,
      },
    } as ProviderRuntimeEvent),
  )[0]!;
  expect(legacy).toMatchObject({
    detail: "legacy command",
    sessionApprovalLabel: "legacy allow",
    sessionApprovalAvailable: true,
  });
  expect(legacy.executionIntent).toBeUndefined();
  const view = await render(
    <PendingApprovalDialog
      approval={legacy}
      open
      pendingCount={1}
      isResponding={false}
      threadTitle="Parent"
      onOpenChange={() => {}}
      onRespondToApproval={async () => {}}
    />,
  );
  await expect.element(page.getByText("legacy command", { exact: true })).toBeVisible();
  await view.unmount();
});
