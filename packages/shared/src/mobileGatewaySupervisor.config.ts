import type { spawn } from "node:child_process";
import { isAbsolute, normalize } from "node:path";

export const MOBILE_GATEWAY_POLICY = {
  readinessMs: 10_000,
  shutdownMs: 2_000,
  crashWindowMs: 5 * 60_000,
  maxCrashRestarts: 5,
  retryBaseMs: 500,
  maxReadyBytes: 4096,
} as const;
export const MOBILE_GATEWAY_CREDENTIAL_ENV = "BIGBUD_MOBILE_GATEWAY_UPSTREAM_CREDENTIAL";
export type MobileGatewayStatus = "stopped" | "starting" | "ready" | "retrying" | "needs-repair";
export interface MobileGatewayLaunch {
  readonly binary: string;
  readonly port: number;
  readonly upstream:
    | { readonly kind: "loopback"; readonly port: number }
    | { readonly kind: "unix"; readonly path: string };
  readonly externalOrigin: string;
  readonly assetsDir?: string;
  readonly credential: string;
}
export interface MobileGatewayDependencies {
  readonly spawn?: typeof spawn;
  /** False when each launch needs the owning service's separate durable admission. */
  readonly autoRestart?: boolean;
  readonly now?: () => number;
  readonly allowed?: () => boolean;
  readonly onStatus?: (status: MobileGatewayStatus) => void;
}
function port(value: number) {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}
function path(value: string) {
  return isAbsolute(value) && normalize(value) === value && !/\p{Cc}/u.test(value);
}

/** Launch description only: provenance and consent remain with the lifetime owner. */
export function mobileGatewayCommand(config: MobileGatewayLaunch) {
  const origin = new URL(config.externalOrigin);
  if (
    !path(config.binary) ||
    !port(config.port) ||
    !/^[\x21-\x7e]{32,256}$/.test(config.credential) ||
    origin.protocol !== "https:" ||
    origin.origin !== config.externalOrigin ||
    origin.username ||
    origin.password ||
    (config.assetsDir !== undefined && !path(config.assetsDir))
  )
    throw new Error("Invalid mobile gateway launch description.");
  const upstream = config.upstream;
  if (
    upstream.kind === "loopback"
      ? !port(upstream.port) || upstream.port === config.port
      : !path(upstream.path) || Buffer.byteLength(upstream.path) >= 108
  )
    throw new Error("Invalid mobile gateway upstream.");
  const args = [
    "--listen",
    `127.0.0.1:${config.port}`,
    ...(upstream.kind === "loopback"
      ? ["--upstream", `127.0.0.1:${upstream.port}`]
      : ["--upstream-unix", upstream.path]),
    "--external-origin",
    config.externalOrigin,
    "--stdin-lifeline",
    ...(config.assetsDir ? ["--assets-dir", config.assetsDir] : []),
  ];
  // The transport never needs provider keys, backend tokens or service-entry markers.
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    [MOBILE_GATEWAY_CREDENTIAL_ENV]: config.credential,
  };
  for (const key of ["HOME", "SystemRoot", "WINDIR", "TEMP", "TMP"])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  if (process.platform === "win32")
    env.PATH = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`;
  return { args, env };
}
