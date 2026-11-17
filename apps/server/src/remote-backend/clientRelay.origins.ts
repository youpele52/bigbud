/** The packaged desktop renderer origin. Exact match only: no other custom scheme is trusted. */
export const DESKTOP_APP_RENDERER_ORIGIN = "bigbud://app";

/** Browser origins a local relay lease accepts. Loopback on the local backend port, the dev URL,
 * and (only for a desktop-mode backend) the packaged desktop renderer origin. */
export function clientRelayAllowedOrigins(input: {
  readonly port: number;
  readonly devUrl: URL | undefined;
  readonly mode: string;
}): ReadonlyArray<string> {
  const origins = [`http://127.0.0.1:${input.port}`, `http://localhost:${input.port}`];
  if (input.devUrl) origins.push(input.devUrl.origin);
  if (input.mode === "desktop") origins.push(DESKTOP_APP_RENDERER_ORIGIN);
  return origins;
}
