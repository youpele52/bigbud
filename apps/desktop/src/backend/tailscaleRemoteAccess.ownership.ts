import * as FS from "node:fs";
import * as Path from "node:path";

/** Serve's default HTTPS listener; records written before per-channel ports implied it. */
export const LEGACY_SERVE_HTTPS_PORT = 443;

/**
 * Remembers which backend port bigbud itself pointed Tailscale Serve at, so a
 * later port change can be recognised as bigbud's stale mapping rather than
 * guessed from "any loopback proxy" (which could be another local service).
 *
 * Each desktop channel owns exactly one Serve HTTPS listener (`httpsPort`, see
 * `resolveTailscaleServeHttpsPort`) and its store only ever describes the "/"
 * handler on that listener; other channels' listeners are never claimed.
 */
export interface ServeOwnershipStore {
  readonly httpsPort: number;
  readonly read: () => number | null;
  readonly write: (port: number) => void;
  readonly clear: () => void;
}

/** No record: every loopback mapping that is not this backend counts as foreign. */
export const NO_SERVE_OWNERSHIP: ServeOwnershipStore = {
  httpsPort: LEGACY_SERVE_HTTPS_PORT,
  read: () => null,
  write: () => undefined,
  clear: () => undefined,
};

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65_535;
}

function readField(parsed: unknown, field: string): unknown {
  return typeof parsed === "object" && parsed !== null && field in parsed
    ? (parsed as Record<string, unknown>)[field]
    : undefined;
}

export function createFileServeOwnershipStore(
  filePath: string,
  httpsPort: number,
): ServeOwnershipStore {
  return {
    httpsPort,
    read: () => {
      try {
        const parsed: unknown = JSON.parse(FS.readFileSync(filePath, "utf8"));
        const proxyPort = readField(parsed, "proxyPort");
        const recordedHttpsPort = readField(parsed, "httpsPort") ?? LEGACY_SERVE_HTTPS_PORT;
        // A record for another listener (for example a pre-split 443 record read by a
        // channel that now serves 8443) never grants ownership of this listener.
        return isPort(proxyPort) && recordedHttpsPort === httpsPort ? proxyPort : null;
      } catch {
        // Missing or unreadable record: claim nothing.
        return null;
      }
    },
    write: (port) => {
      FS.mkdirSync(Path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.${process.pid}.tmp`;
      FS.writeFileSync(temporaryPath, JSON.stringify({ httpsPort, proxyPort: port }), {
        mode: 0o600,
      });
      FS.renameSync(temporaryPath, filePath);
    },
    clear: () => {
      FS.rmSync(filePath, { force: true });
    },
  };
}
