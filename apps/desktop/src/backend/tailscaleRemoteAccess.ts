import * as ChildProcess from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(ChildProcess.execFile);

const TAILSCALE_BINARY = "tailscale";
const LOOPBACK_PROXY_TARGET_HOST = "127.0.0.1";

interface TailscaleStatusResponse {
  readonly BackendState?: unknown;
  readonly Self?: {
    readonly DNSName?: unknown;
    readonly Online?: unknown;
  };
}

export interface DesktopTailscaleRemoteAccessStatus {
  readonly installed: boolean;
  readonly running: boolean;
  readonly online: boolean;
  readonly serving: boolean;
  readonly remoteBaseUrl: string | null;
  readonly error: string | null;
}

interface ExecFileLikeResult {
  readonly stdout: string;
  readonly stderr: string;
}

type ExecFileLike = (
  file: string,
  args: readonly string[],
  options?: ChildProcess.ExecFileOptions,
) => Promise<ExecFileLikeResult>;

function normalizeDnsName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
}

function normalizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Tailscale command failed.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0;
}

function collectProxyTargets(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectProxyTargets(entry));
  }
  if (!isRecord(value)) {
    return [];
  }

  const targets =
    typeof value.Proxy === "string" && value.Proxy.trim().length > 0 ? [value.Proxy] : [];
  return [...targets, ...Object.values(value).flatMap((entry) => collectProxyTargets(entry))];
}

function isExpectedProxyTarget(target: string, backendPort: number): boolean {
  const trimmed = target.trim();
  if (!trimmed) {
    return false;
  }

  const withProtocol = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  try {
    const parsed = new URL(withProtocol);
    return (
      parsed.hostname === LOOPBACK_PROXY_TARGET_HOST &&
      parsed.port === String(backendPort) &&
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.pathname === "/" || parsed.pathname.length === 0)
    );
  } catch {
    return false;
  }
}

async function runTailscaleJsonCommand(
  args: readonly string[],
  runExecFile: ExecFileLike = execFile,
): Promise<unknown> {
  const result = await runExecFile(TAILSCALE_BINARY, args, {
    encoding: "utf8",
    windowsHide: true,
  });
  return JSON.parse(result.stdout);
}

function buildRemoteBaseUrl(hostname: string | null): string | null {
  return hostname ? `https://${hostname}` : null;
}

function isOnline(value: unknown): boolean {
  return value === true;
}

export async function getDesktopTailscaleRemoteAccessStatus(
  backendPort: number,
  runExecFile: ExecFileLike = execFile,
): Promise<DesktopTailscaleRemoteAccessStatus> {
  try {
    const status = (await runTailscaleJsonCommand(
      ["status", "--json"],
      runExecFile,
    )) as TailscaleStatusResponse;
    const running = status.BackendState === "Running";
    const online = isOnline(status.Self?.Online);
    const remoteBaseUrl = buildRemoteBaseUrl(normalizeDnsName(status.Self?.DNSName));

    if (!running) {
      return {
        installed: true,
        running: false,
        online: false,
        serving: false,
        remoteBaseUrl,
        error: "Tailscale is installed but the daemon is not running.",
      };
    }

    if (!online) {
      return {
        installed: true,
        running: true,
        online: false,
        serving: false,
        remoteBaseUrl,
        error: "Tailscale is running but this device is offline.",
      };
    }

    const serveConfig = await runTailscaleJsonCommand(["serve", "status", "--json"], runExecFile);
    const serving =
      isNonEmptyRecord(serveConfig) &&
      collectProxyTargets(serveConfig).some((target) => isExpectedProxyTarget(target, backendPort));

    return {
      installed: true,
      running: true,
      online: true,
      serving,
      remoteBaseUrl,
      error: serving ? null : "Tailscale Serve is not exposing this desktop backend.",
    };
  } catch (error) {
    const errorMessage = normalizeError(error);
    const installed = !errorMessage.includes("ENOENT");
    return {
      installed,
      running: false,
      online: false,
      serving: false,
      remoteBaseUrl: null,
      error: installed ? errorMessage : "Tailscale CLI is not installed.",
    };
  }
}

export async function enableDesktopTailscaleRemoteAccess(
  backendPort: number,
  runExecFile: ExecFileLike = execFile,
): Promise<DesktopTailscaleRemoteAccessStatus> {
  await runExecFile(
    TAILSCALE_BINARY,
    ["serve", "--yes", "--bg", `http://${LOOPBACK_PROXY_TARGET_HOST}:${backendPort}`],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  return getDesktopTailscaleRemoteAccessStatus(backendPort, runExecFile);
}

export async function disableDesktopTailscaleRemoteAccess(
  backendPort: number,
  runExecFile: ExecFileLike = execFile,
): Promise<DesktopTailscaleRemoteAccessStatus> {
  await runExecFile(TAILSCALE_BINARY, ["serve", "--yes", "--https=443", "off"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return getDesktopTailscaleRemoteAccessStatus(backendPort, runExecFile);
}
