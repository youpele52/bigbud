import * as FS from "node:fs";
import * as Path from "node:path";

/**
 * Remembers which backend port bigbud itself pointed Tailscale Serve at, so a
 * later port change can be recognised as bigbud's stale mapping rather than
 * guessed from "any loopback proxy" (which could be another local service).
 */
export interface ServeOwnershipStore {
  readonly read: () => number | null;
  readonly write: (port: number) => void;
  readonly clear: () => void;
}

/** No record: every loopback mapping that is not this backend counts as foreign. */
export const NO_SERVE_OWNERSHIP: ServeOwnershipStore = {
  read: () => null,
  write: () => undefined,
  clear: () => undefined,
};

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65_535;
}

export function createFileServeOwnershipStore(filePath: string): ServeOwnershipStore {
  return {
    read: () => {
      try {
        const parsed: unknown = JSON.parse(FS.readFileSync(filePath, "utf8"));
        const port =
          typeof parsed === "object" && parsed !== null && "proxyPort" in parsed
            ? parsed.proxyPort
            : null;
        return isPort(port) ? port : null;
      } catch {
        // Missing or unreadable record: claim nothing.
        return null;
      }
    },
    write: (port) => {
      FS.mkdirSync(Path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.${process.pid}.tmp`;
      FS.writeFileSync(temporaryPath, JSON.stringify({ proxyPort: port }), { mode: 0o600 });
      FS.renameSync(temporaryPath, filePath);
    },
    clear: () => {
      FS.rmSync(filePath, { force: true });
    },
  };
}
