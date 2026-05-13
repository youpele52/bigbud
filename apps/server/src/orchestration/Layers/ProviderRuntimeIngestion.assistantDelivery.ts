import {
  type AssistantDeliveryMode,
  type ProviderRuntimeEvent,
  type ServerSettings,
} from "@bigbud/contracts";

export function resolveAssistantDeliveryMode(input: {
  readonly provider: ProviderRuntimeEvent["provider"];
  readonly settings: Pick<ServerSettings, "enableAssistantStreaming">;
}): AssistantDeliveryMode {
  void input.provider;
  return input.settings.enableAssistantStreaming ? "streaming" : "buffered";
}
