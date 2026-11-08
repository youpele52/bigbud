import type { OrchestrationCommand, ProjectId, ThreadId } from "@bigbud/contracts";

export function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: ProjectId | ThreadId;
} {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.reconfigure":
    case "project.delete":
    case "project.delete.finalize":
    case "project.delete.abort":
      return { aggregateKind: "project", aggregateId: command.projectId };
    default:
      return { aggregateKind: "thread", aggregateId: command.threadId };
  }
}
