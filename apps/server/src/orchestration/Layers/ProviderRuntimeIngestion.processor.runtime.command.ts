import { CommandId, type ProviderRuntimeEvent } from "@bigbud/contracts";

export const providerCommandId = (event: ProviderRuntimeEvent, tag: string): CommandId =>
  CommandId.makeUnsafe(`provider:${event.eventId}:${tag}:${crypto.randomUUID()}`);
