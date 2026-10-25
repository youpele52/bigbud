import { EventId, type OrchestrationEvent, type OrchestrationReadModel } from "@bigbud/contracts";
import { expect, vi } from "vitest";
import { useStore } from "../../../../stores/main";

/** Catalogs intentionally omit settings; deliver the fake backend's settings update normally. */
export async function publishProjectMetadata(input: {
  readSnapshot: () => OrchestrationReadModel;
  writeSnapshot: (snapshot: OrchestrationReadModel) => void;
  emitEvent: (event: OrchestrationEvent) => void;
}) {
  await vi.waitFor(() => expect(useStore.getState().bootstrapComplete).toBe(true), {
    timeout: 8_000,
  });
  for (const project of input.readSnapshot().projects) {
    if (project.scripts.length === 0 && project.defaultModelSelection === null) continue;
    const snapshot = input.readSnapshot();
    const sequence = snapshot.snapshotSequence + 1;
    input.writeSnapshot({ ...snapshot, snapshotSequence: sequence });
    input.emitEvent({
      sequence,
      eventId: EventId.makeUnsafe(`project-settings-${project.id}-${sequence}`),
      aggregateKind: "project",
      aggregateId: project.id,
      occurredAt: project.updatedAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.meta-updated",
      payload: {
        projectId: project.id,
        defaultModelSelection: project.defaultModelSelection,
        scripts: project.scripts,
        updatedAt: project.updatedAt,
      },
    });
    await vi.waitFor(() =>
      expect(
        useStore.getState().projects.find((entry) => entry.id === project.id)?.scripts,
      ).toEqual(project.scripts),
    );
  }
}
