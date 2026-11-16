import type { ServerConfig, ServerConfigStreamEvent } from "@bigbud/contracts/server/server";

export interface ScopedMobileServerConfig {
  readonly client: object;
  readonly sessionId: string;
  readonly config: ServerConfig | null;
}

export function currentMobileServerConfig(
  state: ScopedMobileServerConfig | null,
  client: object | null,
  sessionId: string | undefined,
): ServerConfig | null {
  return state?.client === client && state?.sessionId === sessionId
    ? (state?.config ?? null)
    : null;
}

export function applyMobileServerConfigEvent(
  previous: ServerConfig | null,
  event: ServerConfigStreamEvent,
): ServerConfig | null {
  if (event.type === "snapshot") return event.config;
  if (event.type === "providerStatuses" && previous)
    return { ...previous, providers: [...event.payload.providers] };
  return previous;
}

export function subscribeMobileServerConfig(
  client: { onServerConfigEvent: (listener: (event: unknown) => void) => () => void },
  sessionId: string,
  update: (
    apply: (previous: ScopedMobileServerConfig | null) => ScopedMobileServerConfig | null,
  ) => void,
) {
  let active = true;
  const unsubscribe = client.onServerConfigEvent((event) => {
    if (!active || !event || typeof event !== "object" || !("type" in event)) return;
    if (event.type !== "snapshot" && event.type !== "providerStatuses") return;
    const streamEvent = event as ServerConfigStreamEvent;
    update((previous) =>
      active
        ? {
            client,
            sessionId,
            config: applyMobileServerConfigEvent(
              currentMobileServerConfig(previous, client, sessionId),
              streamEvent,
            ),
          }
        : previous,
    );
  });
  return () => {
    active = false;
    unsubscribe();
  };
}
