import { EventId, MessageId, ProjectId } from "@bigbud/contracts";

export const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
export const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
export const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
