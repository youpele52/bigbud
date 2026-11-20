import * as FS from "node:fs/promises";
import * as Net from "node:net";
import * as Path from "node:path";

import {
  parseStateDirLockRecord,
  STATE_DIR_LOCK_FILENAME,
} from "@bigbud/shared/backendOwnership.record";

/**
 * Decides whether an unmarked Serve handler (`/` → 127.0.0.1:<port>) belongs to
 * another bigbud backend, so the UI may offer an explicit "Take over".
 *
 * Evidence: every bigbud backend (stable v0.3.x included) writes
 * `<baseDir>/{userdata,dev}/backend.lock` (`bigbud.backend-lock.v1`) recording
 * its pid and loopback port. A record for that port counts only when its
 * process is alive, or when nothing listens on the port any more (a stopped
 * bigbud, so replacing the handler cannot cut off another running service).
 * No HTTP probe is used: the stable 0.3.x backend has no identity endpoint
 * (`/api/mobile/handshake` arrived later), and a lock record is local proof
 * that does not trust whatever answers on the port.
 */
export interface BigbudLoopbackOwner {
  /** Human label, for example "bigbud beta" or "bigbud (development)". */
  readonly label: string;
}

export type LoopbackOwnerDetector = (port: number) => Promise<BigbudLoopbackOwner | null>;

export const NO_LOOPBACK_OWNER_DETECTOR: LoopbackOwnerDetector = async () => null;

interface LockCandidate {
  readonly path: string;
  readonly label: string;
}

const PORT_PROBE_TIMEOUT_MS = 500;

function stateDirCandidates(baseDir: string, label: string): LockCandidate[] {
  return [
    { path: Path.join(baseDir, "userdata", STATE_DIR_LOCK_FILENAME), label },
    { path: Path.join(baseDir, "dev", STATE_DIR_LOCK_FILENAME), label: `${label} (development)` },
  ];
}

/** `<root>` is stable's base dir; prerelease channels live in `<root>/channels/<channel>`. */
async function listLockCandidates(root: string): Promise<LockCandidate[]> {
  const candidates = stateDirCandidates(root, "bigbud");
  const channelsDir = Path.join(root, "channels");
  const channels = await FS.readdir(channelsDir).catch(() => [] as string[]);
  for (const channel of channels.toSorted()) {
    candidates.push(...stateDirCandidates(Path.join(channelsDir, channel), `bigbud ${channel}`));
  }
  return candidates;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Unknown (timeout or unexpected error) counts as listening, the conservative answer. */
export function isLoopbackPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = Net.connect({ host: "127.0.0.1", port });
    const finish = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => finish(true));
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code !== "ECONNREFUSED"));
  });
}

export function createBigbudLockOwnerDetector(
  roots: readonly string[],
  deps: {
    readonly isAlive?: (pid: number) => boolean;
    readonly isListening?: (port: number) => Promise<boolean>;
  } = {},
): LoopbackOwnerDetector {
  const isAlive = deps.isAlive ?? isProcessAlive;
  const isListening = deps.isListening ?? isLoopbackPortListening;
  return async (port) => {
    const uniqueRoots = [...new Set(roots.map((root) => Path.resolve(root)))];
    for (const root of uniqueRoots) {
      for (const candidate of await listLockCandidates(root)) {
        const raw = await FS.readFile(candidate.path, "utf8").catch(() => null);
        const record = raw === null ? undefined : parseStateDirLockRecord(raw);
        if (!record || record.port !== port) continue;
        if (isAlive(record.pid) || !(await isListening(port))) {
          return { label: candidate.label };
        }
      }
    }
    return null;
  };
}
