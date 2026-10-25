import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@bigbud/contracts";

import { withEventBase } from "./deciderHelpers.ts";
import { verifiedSeedOriginSegments } from "./ThreadMessageOrigin.logic.ts";

type CreateCommand = Extract<OrchestrationCommand, { type: "thread.create" }>;

export function seedMessageEvent(input: {
  readonly command: CreateCommand;
  readonly message: NonNullable<CreateCommand["seedMessages"]>[number];
  readonly readModel: OrchestrationReadModel;
}): Omit<OrchestrationEvent, "sequence"> {
  const { command, message, readModel } = input;
  const originSegments = verifiedSeedOriginSegments({
    message,
    parentThread: command.parentThread,
    projectId: command.projectId,
    readModel,
  });
  return {
    ...withEventBase({
      aggregateKind: "thread",
      aggregateId: command.threadId,
      occurredAt: message.updatedAt,
      commandId: command.commandId,
    }),
    type: "thread.message-sent",
    payload: {
      threadId: command.threadId,
      messageId: message.id,
      role: message.role,
      text: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(originSegments !== undefined ? { originSegments } : {}),
      turnId: message.turnId,
      streaming: message.streaming,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    },
  };
}
