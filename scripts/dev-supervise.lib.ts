/**
 * Dev-task supervisor. turbo signals only a task's top process (`bun run dev`), and Bun's script
 * runner exits without forwarding that signal to its children, so long-running dev processes
 * (tsdown watchers, the Electron launcher, Vite) were orphaned and turbo waited on them forever
 * ("1 task shutting down..."). The supervisor stops every command's whole process tree on a
 * signal, or as soon as its own parent disappears.
 *
 * Children stay in the supervisor's (foreground) process group: a separate group would be a
 * background job on turbo's terminal, and tools that read stdin (Vite) would stop on SIGTTIN.
 * Trees are therefore addressed by PID, snapshotted when shutdown starts so grandchildren that
 * get reparented mid-shutdown are still covered.
 */

export interface DevCommand {
  readonly name: string;
  readonly command: string;
}

export type ShutdownSignal = "SIGINT" | "SIGTERM" | "SIGHUP";
type AnySignal = ShutdownSignal | "SIGKILL";

/**
 * Must exceed the Electron launcher's worst-case shutdown (`DEV_ELECTRON_MAX_SHUTDOWN_MS`, 5.7 s:
 * 4 s graceful app-tree stop, 0.5 s forced settle, 1.2 s child grace) so the launcher finishes its
 * own tree-aware stop before this supervisor force-kills it. The full budget ordering is documented
 * in `scripts/lib/dev-electron-launcher.ts`.
 */
export const DEV_SUPERVISOR_GRACE_MS = 8_000;
export const DEV_SUPERVISOR_ORPHAN_POLL_MS = 250;
const DRAIN_POLL_MS = 50;

const SIGNAL_EXIT_CODES: Record<ShutdownSignal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
};

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * `name=command` arguments, matching the labels `bun run --parallel` printed. Arguments from the
 * first one starting with `-` are passed through (shell-quoted) to a single command, so
 * `turbo run dev -- --flag` keeps working for single-command packages.
 */
export function parseDevCommands(argv: readonly string[]): DevCommand[] {
  const firstFlag = argv.findIndex((argument) => argument.startsWith("-"));
  const definitions = firstFlag === -1 ? argv : argv.slice(0, firstFlag);
  const passthrough = firstFlag === -1 ? [] : argv.slice(firstFlag);
  if (definitions.length === 0)
    throw new Error("dev-supervise: expected at least one name=command");
  if (passthrough.length > 0 && definitions.length > 1)
    throw new Error("dev-supervise: extra arguments are only supported for a single command");
  const commands = definitions.map((argument) => {
    const separator = argument.indexOf("=");
    const name = argument.slice(0, separator).trim();
    const command = argument.slice(separator + 1).trim();
    if (separator <= 0 || !name || !command)
      throw new Error(`dev-supervise: expected name=command, got ${JSON.stringify(argument)}`);
    return { name, command };
  });
  if (passthrough.length === 0) return commands;
  const [only] = commands;
  return [{ name: only!.name, command: [only!.command, ...passthrough.map(shellQuote)].join(" ") }];
}

export interface SupervisedProcess {
  readonly pid: number | undefined;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
}

export interface DevSupervisorHost {
  spawn(command: DevCommand, prefixOutput: boolean): SupervisedProcess;
  /** `pid` and all its current descendants. */
  processTree(pid: number): number[];
  signal(pid: number, signal: AnySignal): void;
  alive(pid: number): boolean;
  parentPid(): number;
  onSignal(signal: ShutdownSignal, listener: () => void): void;
  setTimer(callback: () => void, ms: number): unknown;
  setRepeating(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  log(message: string): void;
  exit(code: number): void;
}

interface Running {
  readonly command: DevCommand;
  readonly child: SupervisedProcess;
  exited: boolean;
}

export class DevSupervisor {
  private readonly running: Running[] = [];
  private readonly targets = new Set<number>();
  private stopping = false;
  private finished = false;
  private exitCode = 0;
  private graceTimer: unknown = null;
  private drainTimer: unknown = null;
  private orphanTimer: unknown = null;

  private readonly commands: readonly DevCommand[];
  private readonly host: DevSupervisorHost;
  private readonly graceMs: number;

  // Plain fields, not parameter properties: Node runs this file with strip-only type removal.
  constructor(
    commands: readonly DevCommand[],
    host: DevSupervisorHost,
    graceMs = DEV_SUPERVISOR_GRACE_MS,
  ) {
    this.commands = commands;
    this.host = host;
    this.graceMs = graceMs;
  }

  start(): void {
    const initialParent = this.host.parentPid();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
      this.host.onSignal(signal, () => this.stop(signal, SIGNAL_EXIT_CODES[signal]));
    // The turbo case: our `bun run` parent died without telling us. Reparenting is the signal.
    this.orphanTimer = this.host.setRepeating(() => {
      if (this.host.parentPid() === initialParent) return;
      this.host.log("dev-supervise: parent exited; stopping dev processes");
      this.stop("SIGTERM", SIGNAL_EXIT_CODES.SIGTERM);
    }, DEV_SUPERVISOR_ORPHAN_POLL_MS);
    const prefixOutput = this.commands.length > 1;
    for (const command of this.commands) {
      const entry: Running = {
        command,
        child: this.host.spawn(command, prefixOutput),
        exited: false,
      };
      this.running.push(entry);
      entry.child.onExit((code, signal) => this.onChildExit(entry, code, signal));
    }
  }

  private onChildExit(entry: Running, code: number | null, signal: string | null): void {
    entry.exited = true;
    if (this.stopping) return;
    if (signal !== null || (code ?? 1) !== 0) {
      // `bun run --parallel` semantics: one failure stops the rest with its code.
      this.host.log(
        `${entry.command.name} | exited with ${signal ?? `code ${String(code)}`}; stopping the rest`,
      );
      this.stop("SIGTERM", code !== null && code > 0 ? code : 1);
      return;
    }
    // A clean exit leaves the others running until they finish too.
    if (this.running.every((current) => current.exited)) this.stop("SIGTERM", 0);
  }

  /** Idempotent: signal every tree, then force-kill whatever is left after the grace period. */
  stop(signal: ShutdownSignal, exitCode: number): void {
    if (this.stopping) return;
    this.stopping = true;
    this.exitCode = exitCode;
    this.clear(this.orphanTimer);
    this.orphanTimer = null;
    this.collectTargets();
    for (const pid of this.targets) this.signalQuietly(pid, signal);
    this.graceTimer = this.host.setTimer(() => {
      this.graceTimer = null;
      this.collectTargets();
      for (const pid of this.targets) this.signalQuietly(pid, "SIGKILL");
      this.finish();
    }, this.graceMs);
    this.drainTimer = this.host.setRepeating(() => {
      if (this.drained()) this.finish();
    }, DRAIN_POLL_MS);
    if (this.drained()) this.finish();
  }

  private collectTargets(): void {
    for (const entry of this.running) {
      const pid = entry.child.pid;
      if (pid === undefined || entry.exited) continue;
      try {
        for (const member of this.host.processTree(pid)) this.targets.add(member);
      } catch {
        this.targets.add(pid);
      }
    }
  }

  private drained(): boolean {
    if (!this.running.every((entry) => entry.exited)) return false;
    for (const pid of this.targets) {
      let alive = false;
      try {
        alive = this.host.alive(pid);
      } catch {
        alive = false;
      }
      if (alive) return false;
      this.targets.delete(pid);
    }
    return true;
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.clear(this.orphanTimer);
    this.clear(this.graceTimer);
    this.clear(this.drainTimer);
    this.orphanTimer = this.graceTimer = this.drainTimer = null;
    this.host.exit(this.exitCode);
  }

  private clear(timer: unknown): void {
    if (timer !== null) this.host.clearTimer(timer);
  }

  private signalQuietly(pid: number, signal: AnySignal): void {
    try {
      this.host.signal(pid, signal);
    } catch {
      /* Already gone. */
    }
  }
}
