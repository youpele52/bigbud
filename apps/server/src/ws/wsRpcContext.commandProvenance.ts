import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";

/** Public transports cannot assert server-verified message provenance. */
export function stripPublicProvenance(command: OrchestrationCommand): OrchestrationCommand {
  if (command.type === "thread.message.submit") {
    const { originSegments: _originSegments, ...safe } = command;
    return safe;
  }
  if (command.type === "thread.turn.start") {
    const assignments = command.message.originSegments
      ?.filter(
        (segment) => segment.kind === "orchestraAssignment" && segment.actor === "userAssignment",
      )
      .map((segment) => ({
        kind: segment.kind,
        actor: segment.actor,
        text: segment.text,
        sourceThreads: segment.sourceThreads,
        verified: false,
      }));
    const { originSegments: _originSegments, ...safe } = command.message;
    return {
      ...command,
      message: assignments?.length ? { ...safe, originSegments: assignments } : safe,
    };
  }
  if (command.type === "thread.create" && command.seedMessages) {
    return {
      ...command,
      seedMessages: command.seedMessages.map((message) => {
        const handoffs = message.originSegments
          ?.filter((segment) => segment.kind === "handoff")
          .map((segment) => ({
            kind: segment.kind,
            actor: "userAssignment" as const,
            text: segment.text,
            sourceThreads: segment.sourceThreads,
            verified: false,
          }));
        const { originSegments: _originSegments, ...safe } = message;
        return handoffs?.length ? { ...safe, originSegments: handoffs } : safe;
      }),
    };
  }
  return command;
}
