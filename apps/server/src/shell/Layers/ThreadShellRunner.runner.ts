import { Buffer } from "node:buffer";

import { sanitizeTerminalHistoryChunk } from "../../terminal/Layers/Manager.history";
import {
  createTerminalSpawnEnv,
  defaultShellResolver,
  formatShellCandidate,
  isRetryableShellSpawnError,
  resolveShellCandidates,
} from "../../terminal/Layers/Manager.shell";
import { type PtyProcess, type PtySpawnInput } from "../../terminal/Services/PTY";
import { type ThreadShellRunInput, type ThreadShellRunResult } from "../Services/ThreadShellRunner";
import {
  buildCommandEndMarker,
  buildCommandScript,
  buildCommandStartMarker,
  buildReadyMarker,
  buildReadyScript,
  DEFAULT_COLS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_IDLE_TTL_MS,
  DEFAULT_ROWS,
  findFlushBoundary,
  findLineMarker,
  MAX_UNFLUSHED_OUTPUT_BYTES,
  METADATA_SEPARATOR,
  normalizeVisibleText,
  parseCommandCompletion,
  trimLeadingCommandNewline,
} from "./ThreadShellRunner.capture";
import { consumeReadyCapture, emitCommandOutput } from "./ThreadShellRunner.runner.capture";
import {
  type ActiveCommandCapture,
  type HiddenShellSession,
} from "./ThreadShellRunner.runner.types";

export class PersistentThreadPtyShellRunner {
  private readonly sessions = new Map<string, HiddenShellSession>();
  private readonly threadLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly options: {
      readonly spawnPty: (input: PtySpawnInput) => Promise<PtyProcess>;
      readonly shellResolver?: () => string;
      readonly baseEnv?: NodeJS.ProcessEnv;
      readonly commandTimeoutMs?: number;
      readonly idleTtlMs?: number;
    },
  ) {}

  async run(input: ThreadShellRunInput): Promise<ThreadShellRunResult> {
    return this.withThreadLock(input.threadId, async () => {
      const session = await this.ensureSession(input.threadId, input.cwd);
      this.clearIdleTimer(session);

      try {
        const result = await this.executeCommand(session, input);
        this.scheduleIdleClose(session);
        return result;
      } catch (error) {
        this.scheduleIdleClose(session);
        throw error;
      }
    });
  }

  async closeThread(threadId: string): Promise<void> {
    await this.withThreadLock(threadId, async () => {
      this.destroySession(threadId, "SIGKILL");
    });
  }

  async closeAll(): Promise<void> {
    for (const threadId of this.sessions.keys()) {
      this.destroySession(threadId, "SIGKILL");
    }
  }

  private async withThreadLock<A>(threadId: string, run: () => Promise<A>): Promise<A> {
    const previous = this.threadLocks.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.threadLocks.set(
      threadId,
      previous.then(() => current),
    );
    await previous.catch(() => undefined);

    try {
      return await run();
    } finally {
      release();
      if (this.threadLocks.get(threadId) === current) {
        this.threadLocks.delete(threadId);
      }
    }
  }

  private async ensureSession(threadId: string, cwd: string): Promise<HiddenShellSession> {
    const existing = this.sessions.get(threadId);
    if (existing) {
      return existing;
    }

    const session = await this.spawnSession(threadId, cwd);
    this.sessions.set(threadId, session);
    return session;
  }

  private async spawnSession(threadId: string, cwd: string): Promise<HiddenShellSession> {
    const shellCandidates = resolveShellCandidates(
      this.options.shellResolver ?? defaultShellResolver,
    );
    const spawnEnv = createTerminalSpawnEnv(this.options.baseEnv ?? process.env, null);
    let lastError: Error | null = null;

    for (const candidate of shellCandidates) {
      try {
        const process = await this.options.spawnPty({
          shell: candidate.shell,
          ...(candidate.args ? { args: candidate.args } : {}),
          cwd,
          cols: DEFAULT_COLS,
          rows: DEFAULT_ROWS,
          env: spawnEnv,
        });

        const session: HiddenShellSession = {
          threadId,
          process,
          pendingControlSequence: "",
          lastKnownCwd: cwd,
          activeCapture: null,
          idleTimer: null,
        };

        process.onData((data) => {
          this.handleData(session, data);
        });
        process.onExit((event) => {
          this.handleExit(session, event.exitCode, event.signal);
        });

        await this.initializeSession(session);
        return session;
      } catch (error) {
        const spawnError =
          error instanceof Error ? error : new Error("Failed to spawn hidden shell session.");
        lastError = spawnError;
        if (!isRetryableShellSpawnError({ message: spawnError.message, cause: spawnError.cause })) {
          break;
        }
      }
    }

    const triedShells =
      shellCandidates.length > 0
        ? ` Tried shells: ${shellCandidates.map((candidate) => formatShellCandidate(candidate)).join(", ")}.`
        : "";
    throw new Error(
      `${lastError?.message ?? "Failed to spawn hidden shell session."}${triedShells}`.trim(),
    );
  }

  private async initializeSession(session: HiddenShellSession): Promise<void> {
    const readyMarker = buildReadyMarker();
    await new Promise<void>((resolve, reject) => {
      session.activeCapture = {
        kind: "ready",
        marker: readyMarker,
        buffer: "",
        resolve: () => {
          session.activeCapture = null;
          resolve();
        },
        reject: (error) => {
          session.activeCapture = null;
          reject(error);
        },
      };
      session.process.write(`${buildReadyScript(readyMarker)}\r`);
    });
  }

  private async executeCommand(
    session: HiddenShellSession,
    input: ThreadShellRunInput,
  ): Promise<ThreadShellRunResult> {
    const { command } = input;
    const commandId = crypto.randomUUID();
    const startMarker = buildCommandStartMarker(commandId);
    const endMarker = buildCommandEndMarker(commandId);
    const timeoutMs =
      input.timeoutMs === undefined
        ? (this.options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS)
        : input.timeoutMs;

    return await new Promise<ThreadShellRunResult>((resolve, reject) => {
      const timeout =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              if (
                session.activeCapture?.kind === "command" &&
                session.activeCapture.endMarker === endMarker
              ) {
                this.destroySession(session.threadId, "SIGKILL");
                reject(new Error(`Shell command timed out after ${timeoutMs}ms.`));
              }
            }, timeoutMs);

      session.activeCapture = {
        kind: "command",
        startMarker,
        endMarker,
        buffer: "",
        output: "",
        sawStart: false,
        onOutputChunk: input.onOutputChunk,
        timeout,
        resolve: (result) => {
          if (timeout !== null) {
            clearTimeout(timeout);
          }
          session.activeCapture = null;
          resolve(result);
        },
        reject: (error) => {
          if (timeout !== null) {
            clearTimeout(timeout);
          }
          session.activeCapture = null;
          reject(error);
        },
      };

      session.process.write(`${buildCommandScript(command, commandId)}\r`);
    });
  }

  private handleData(session: HiddenShellSession, data: string): void {
    const currentCapture = session.activeCapture;
    const sanitized = sanitizeTerminalHistoryChunk(session.pendingControlSequence, data);
    session.pendingControlSequence = sanitized.pendingControlSequence;

    if (!currentCapture) {
      return;
    }

    const visibleText = normalizeVisibleText(sanitized.visibleText);
    if (visibleText.length === 0) {
      return;
    }

    try {
      if (currentCapture.kind === "ready") {
        consumeReadyCapture(currentCapture, visibleText);
        return;
      }

      this.consumeCommandCapture(session, currentCapture, visibleText);
    } catch (error) {
      currentCapture.reject(
        error instanceof Error ? error : new Error("Hidden shell capture parsing failed."),
      );
    }
  }

  private consumeCommandCapture(
    session: HiddenShellSession,
    capture: ActiveCommandCapture,
    visibleText: string,
  ): void {
    capture.buffer += visibleText;

    if (!capture.sawStart) {
      const startIndex = findLineMarker(capture.buffer, capture.startMarker, "\n");
      if (startIndex === -1) {
        const maxRetained = Math.max(capture.startMarker.length * 2, 256);
        if (capture.buffer.length > maxRetained) {
          capture.buffer = capture.buffer.slice(-maxRetained);
        }
        return;
      }

      capture.buffer = trimLeadingCommandNewline(
        capture.buffer.slice(startIndex + capture.startMarker.length),
      );
      capture.sawStart = true;
    }

    const currentBytes = Buffer.byteLength(capture.buffer, "utf8");
    if (currentBytes > MAX_UNFLUSHED_OUTPUT_BYTES) {
      this.destroySession(session.threadId, "SIGKILL");
      capture.reject(
        new Error(
          `Shell command exceeded output buffer limit (${MAX_UNFLUSHED_OUTPUT_BYTES} bytes).`,
        ),
      );
      return;
    }

    const endIndex = findLineMarker(capture.buffer, capture.endMarker, METADATA_SEPARATOR);
    if (endIndex === -1) {
      emitCommandOutput(capture, findFlushBoundary(capture.buffer));
      return;
    }

    emitCommandOutput(capture, endIndex);

    const lineEndIndex = capture.buffer.indexOf("\n");
    if (lineEndIndex === -1) {
      return;
    }

    const completionLine = capture.buffer.slice(0, lineEndIndex).trimEnd();
    const completion = parseCommandCompletion(completionLine, capture.endMarker);
    if (completion.cwd) {
      session.lastKnownCwd = completion.cwd;
    }

    capture.resolve({
      output: capture.output,
      exitCode: completion.exitCode,
    });
  }

  private handleExit(session: HiddenShellSession, exitCode: number, signal: number | null): void {
    this.clearIdleTimer(session);
    if (this.sessions.get(session.threadId) === session) {
      this.sessions.delete(session.threadId);
    }

    const currentCapture = session.activeCapture;
    if (!currentCapture) {
      return;
    }

    const reason = `Hidden shell session exited before command completion (code=${exitCode}, signal=${signal ?? "null"}).`;
    currentCapture.reject(new Error(reason));
  }

  private destroySession(threadId: string, signal: string): void {
    const session = this.sessions.get(threadId);
    if (!session) {
      return;
    }

    this.clearIdleTimer(session);
    this.sessions.delete(threadId);
    try {
      session.process.kill(signal);
    } catch {
      // Best-effort cleanup only.
    }
  }

  private scheduleIdleClose(session: HiddenShellSession): void {
    this.clearIdleTimer(session);
    const idleTtlMs = this.options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    session.idleTimer = setTimeout(() => {
      this.destroySession(session.threadId, "SIGTERM");
    }, idleTtlMs);
  }

  private clearIdleTimer(session: HiddenShellSession): void {
    if (session.idleTimer !== null) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
  }
}
