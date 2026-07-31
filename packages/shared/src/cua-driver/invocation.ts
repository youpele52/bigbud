function requireHostBundleId(hostBundleId: string): string {
  const value = hostBundleId.trim();
  if (!value) {
    throw new Error("Embedded cua-driver invocation requires a host bundle ID.");
  }
  return value;
}

export function cuaDriverEmbeddedEnvironment(
  socketPath: string,
  hostBundleId: string,
): Record<string, string> {
  return {
    CUA_DRIVER_EMBEDDED: "1",
    CUA_DRIVER_HOST_BUNDLE_ID: requireHostBundleId(hostBundleId),
    CUA_DRIVER_RS_SESSION_IDLE_TTL_SECS: "300",
    CUA_DRIVER_RS_RECORDING_IDLE_TTL_SECS: "60",
    BIGBUD_CUA_ENDPOINT: socketPath,
    BIGBUD_CUA_DRIVER_SOCKET: socketPath,
    BIGBUD_CUA_HOST_BUNDLE_ID: requireHostBundleId(hostBundleId),
  };
}

export function cuaDriverMcpArguments(
  socketPath: string,
  hostBundleId: string,
): ReadonlyArray<string> {
  return [
    "mcp",
    "--embedded",
    "--socket",
    socketPath,
    "--host-bundle-id",
    requireHostBundleId(hostBundleId),
  ];
}

export function cuaDriverServeArguments(
  socketPath: string,
  hostBundleId: string,
): ReadonlyArray<string> {
  return [
    "serve",
    "--embedded",
    "--socket",
    socketPath,
    "--host-bundle-id",
    requireHostBundleId(hostBundleId),
  ];
}
