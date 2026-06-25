import type { ServerConfig, ServerConfigStreamEvent, ServerProvider } from "@bigbud/contracts";
import { useEffect, useState } from "react";

import { useMobileRpcClient } from "../MobileRpcContext";

function asStreamEvent(value: unknown): ServerConfigStreamEvent | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as { type?: unknown };
  return typeof candidate.type === "string" ? (value as ServerConfigStreamEvent) : null;
}

function applyConfigEvent(
  previous: ServerConfig | null,
  event: ServerConfigStreamEvent,
): ServerConfig | null {
  if (event.type === "snapshot") {
    return event.config;
  }
  if (event.type === "providerStatuses") {
    if (!previous) {
      return null;
    }
    return { ...previous, providers: [...event.payload.providers] };
  }
  return previous;
}

function pickProviders(config: ServerConfig | null): ReadonlyArray<ServerProvider> {
  return config?.providers ?? [];
}

export function useMobileServerConfig(session: { sessionId: string } | null) {
  const { client } = useMobileRpcClient();
  const [config, setConfig] = useState<ServerConfig | null>(null);

  useEffect(() => {
    if (!client || !session) {
      setConfig(null);
      return;
    }
    return client.onServerConfigEvent((event) => {
      const streamEvent = asStreamEvent(event);
      if (!streamEvent) {
        return;
      }
      setConfig((existing) => applyConfigEvent(existing, streamEvent));
    });
  }, [client, session]);

  return {
    serverConfig: config,
    providers: pickProviders(config),
    isLoading: client !== null && session !== null && config === null,
  };
}
