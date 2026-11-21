import { execFile } from "node:child_process";

export interface ProcessCommandResult {
  readonly stdout: string;
  readonly code: number | null;
}
export type ProcessCommandRunner = (
  command: string,
  args: ReadonlyArray<string>,
) => Promise<ProcessCommandResult>;

/** `ps` with a fixed locale and PATH so `lstart` parsing never depends on the user's settings. */
export const runProcessCommand: ProcessCommandRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C", LANG: "C" },
      },
      (error, stdout) => {
        const exitCode: unknown = error ? (error as { code?: unknown }).code : 0;
        resolve({
          stdout: typeof stdout === "string" ? stdout : "",
          code: typeof exitCode === "number" ? exitCode : null,
        });
      },
    );
  });

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Parses C-locale `ps -o lstart=` output (`Sat Nov 21 10:00:00 2026`, local time). */
export function parsePsLstart(text: string): number | undefined {
  const match =
    /^\s*[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(
      text,
    );
  if (!match) return undefined;
  const month = MONTHS.indexOf(match[1]!);
  if (month < 0) return undefined;
  const value = new Date(
    Number(match[6]),
    month,
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  ).getTime();
  return Number.isFinite(value) ? value : undefined;
}

export type LocalTerminalHostPidStatus = "verified" | "not-running" | "mismatch" | "unknown";

/** `ps` start time has 1 s resolution, so equal processes differ by less than this. */
export const PID_START_TOLERANCE_MS = 1_000;

export interface LocalTerminalHostProcesses {
  readonly startTime: (pid: number) => Promise<number | "not-running" | undefined>;
  /** Only a PID whose start time matches the recorded one may ever be signalled. */
  readonly verify: (
    pid: number | undefined,
    recordedStartTime: number | undefined,
  ) => Promise<LocalTerminalHostPidStatus>;
  /** `undefined` means the scan failed, which callers must treat as "has children". */
  readonly hasChildren: (pid: number) => Promise<boolean | undefined>;
  readonly isAlive: (pid: number) => boolean;
  readonly signal: (pid: number, signal: NodeJS.Signals) => boolean;
  readonly waitForExit: (pid: number, timeoutMs: number) => Promise<boolean>;
}

export function hasChildProcess(psOutput: string, parentPid: number): boolean {
  for (const line of psOutput.split("\n")) {
    const [ppid, pid] = line.trim().split(/\s+/).map(Number);
    if (ppid === parentPid && Number.isSafeInteger(pid) && pid !== parentPid) return true;
  }
  return false;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function makeLocalTerminalHostProcesses(
  run: ProcessCommandRunner = runProcessCommand,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): LocalTerminalHostProcesses {
  const startTime = async (pid: number) => {
    if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
    const result = await run("ps", ["-o", "lstart=", "-p", String(pid)]);
    if (result.code === 1 && result.stdout.trim() === "") return "not-running" as const;
    if (result.code !== 0) return undefined;
    return parsePsLstart(result.stdout);
  };
  return {
    startTime,
    isAlive,
    verify: async (pid, recorded) => {
      if (pid === undefined || recorded === undefined) return "unknown";
      const actual = await startTime(pid);
      if (actual === "not-running") return "not-running";
      if (actual === undefined) return "unknown";
      return Math.abs(actual - recorded) <= PID_START_TOLERANCE_MS ? "verified" : "mismatch";
    },
    hasChildren: async (pid) => {
      const result = await run("ps", ["-A", "-o", "ppid=,pid="]);
      if (result.code !== 0) return undefined;
      return hasChildProcess(result.stdout, pid);
    },
    signal: (pid, signal) => {
      try {
        return process.kill(pid, signal);
      } catch {
        return false;
      }
    },
    waitForExit: async (pid, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!isAlive(pid)) return true;
        await sleep(50);
      }
      return !isAlive(pid);
    },
  };
}
