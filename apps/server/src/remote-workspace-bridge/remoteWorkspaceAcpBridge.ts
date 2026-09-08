import { randomUUID } from "node:crypto";

import { Effect } from "effect";
import { AcpRequestError } from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

import type { AcpSessionRuntimeShape } from "../provider/acp/AcpSessionRuntime.ts";
import {
  prepareRemoteAgentWorkspacePty,
  type RemoteAgentPtyResolver,
} from "../remote-agent/remoteAgentPtyAdapter.ts";
import type { WorkspaceTarget } from "../workspace-target/workspaceTarget.ts";
import {
  createRemoteWorkspaceSessionFsBridge,
  resolveSessionFsPath,
} from "./remoteWorkspaceSessionFsBridge.ts";
import type { RemoteWorkspaceReadinessProbe } from "./remoteWorkspaceReadiness.ts";
import {
  createRemoteWorkspaceAcpTerminal,
  type AcpTerminalProcess,
} from "./remoteWorkspaceAcpTerminal.ts";

const DEFAULT_TERMINAL_OUTPUT_BYTE_LIMIT = 64 * 1024;

interface AcpRemoteTerminal {
  readonly process: AcpTerminalProcess;
  readonly outputByteLimit: number;
  readonly waitForExit: Promise<AcpSchema.WaitForTerminalExitResponse>;
  output: string;
  truncated: boolean;
  exitStatus: AcpSchema.TerminalExitStatus | undefined;
}

export interface RemoteWorkspaceAcpBridge {
  readonly cwd: string;
  readonly initialCwd: string;
  readonly clientCapabilities: {
    readonly fs: { readonly readTextFile: true; readonly writeTextFile: true };
    readonly terminal: true;
  };
  registerHandlers(acp: AcpSessionRuntimeShape): Effect.Effect<void>;
  cleanup(): Promise<void>;
}

function acpInternalError(cause: unknown): AcpRequestError {
  return AcpRequestError.internalError(cause instanceof Error ? cause.message : String(cause));
}

function terminalNotFound(terminalId: string): AcpRequestError {
  return AcpRequestError.resourceNotFound(`ACP terminal '${terminalId}' was not found.`);
}

function appendTerminalOutput(terminal: AcpRemoteTerminal, data: string): void {
  terminal.output += data;
  while (Buffer.byteLength(terminal.output) > terminal.outputByteLimit) {
    const firstCodePoint = terminal.output.codePointAt(0);
    if (firstCodePoint === undefined) break;
    terminal.output = terminal.output.slice(firstCodePoint > 0xffff ? 2 : 1);
    terminal.truncated = true;
  }
}

function readTextLines(
  content: string,
  line: number | null | undefined,
  limit: number | null | undefined,
) {
  if (line == null && limit == null) return content;
  const start = Math.max(0, (line ?? 1) - 1);
  const lines = content.split("\n");
  return lines.slice(start, limit == null ? undefined : start + limit).join("\n");
}

export async function createRemoteWorkspaceAcpBridge(input: {
  readonly workspaceTarget: WorkspaceTarget;
  readonly ptyResolver: RemoteAgentPtyResolver | undefined;
  readonly prefix: string;
  readonly readmeLines: ReadonlyArray<string>;
  readonly readinessProbe?: RemoteWorkspaceReadinessProbe;
}): Promise<RemoteWorkspaceAcpBridge> {
  const sessionFs = await createRemoteWorkspaceSessionFsBridge(
    input.workspaceTarget,
    input.prefix,
    input.readmeLines,
    input.readinessProbe,
  );
  if (input.ptyResolver) {
    try {
      await prepareRemoteAgentWorkspacePty(
        {
          executionTargetId: input.workspaceTarget.executionTargetId,
          workspaceRoot: sessionFs.initialCwd,
        },
        input.ptyResolver,
      );
    } catch (error) {
      await sessionFs.cleanup();
      throw error;
    }
  }
  const fileSystem = sessionFs.createSessionFsHandler();
  const terminals = new Map<string, AcpRemoteTerminal>();
  let cleaned = false;

  const requireTerminal = (
    terminalId: string,
  ): Effect.Effect<AcpRemoteTerminal, AcpRequestError> => {
    const terminal = terminals.get(terminalId);
    return terminal ? Effect.succeed(terminal) : Effect.fail(terminalNotFound(terminalId));
  };

  const registerHandlers = (acp: AcpSessionRuntimeShape) =>
    Effect.gen(function* () {
      yield* acp.handleReadTextFile((request) =>
        Effect.tryPromise({
          try: async () => ({
            content: readTextLines(
              await fileSystem.readFile(request.path),
              request.line,
              request.limit,
            ),
          }),
          catch: acpInternalError,
        }),
      );
      yield* acp.handleWriteTextFile((request) =>
        Effect.tryPromise({
          try: () => fileSystem.writeFile(request.path, request.content),
          catch: acpInternalError,
        }),
      );
      yield* acp.handleCreateTerminal((request) =>
        Effect.tryPromise({
          try: async () => {
            const terminalId = randomUUID();
            const process = await createRemoteWorkspaceAcpTerminal({
              executionTargetId: input.workspaceTarget.executionTargetId,
              workspaceRoot: sessionFs.initialCwd,
              ...(request.cwd
                ? {
                    cwd: resolveSessionFsPath(request.cwd, sessionFs.initialCwd, sessionFs.cwd)
                      .path,
                  }
                : {}),
              command: request.command,
              args: request.args ?? [],
              ...(request.env ? { environment: request.env } : {}),
              ptyResolver: input.ptyResolver,
            });
            let resolveExit!: (result: AcpSchema.WaitForTerminalExitResponse) => void;
            let rejectExit!: (cause: Error) => void;
            const waitForExit = new Promise<AcpSchema.WaitForTerminalExitResponse>(
              (resolve, reject) => {
                resolveExit = resolve;
                rejectExit = reject;
              },
            );
            const terminal: AcpRemoteTerminal = {
              process,
              outputByteLimit: request.outputByteLimit ?? DEFAULT_TERMINAL_OUTPUT_BYTE_LIMIT,
              waitForExit,
              output: "",
              truncated: false,
              exitStatus: undefined,
            };
            process.onData((data) => appendTerminalOutput(terminal, data));
            process.onExit((event) => {
              const exitStatus = {
                exitCode: event.signal === null ? event.exitCode : null,
                signal: event.signal === null ? null : String(event.signal),
              };
              terminal.exitStatus = exitStatus;
              resolveExit(exitStatus);
            });
            process.onError((error) => rejectExit(error));
            terminals.set(terminalId, terminal);
            return { terminalId };
          },
          catch: acpInternalError,
        }),
      );
      yield* acp.handleTerminalOutput((request) =>
        requireTerminal(request.terminalId).pipe(
          Effect.map((terminal) => ({
            output: terminal.output,
            truncated: terminal.truncated,
            ...(terminal.exitStatus ? { exitStatus: terminal.exitStatus } : {}),
          })),
        ),
      );
      yield* acp.handleTerminalWaitForExit((request) =>
        requireTerminal(request.terminalId).pipe(
          Effect.flatMap((terminal) =>
            Effect.tryPromise({ try: () => terminal.waitForExit, catch: acpInternalError }),
          ),
        ),
      );
      yield* acp.handleTerminalKill((request) =>
        requireTerminal(request.terminalId).pipe(
          Effect.tap((terminal) => Effect.sync(() => terminal.process.kill("SIGTERM"))),
          Effect.asVoid,
        ),
      );
      yield* acp.handleTerminalRelease((request) =>
        requireTerminal(request.terminalId).pipe(
          Effect.flatMap((terminal) =>
            Effect.tryPromise({
              try: () => terminal.process.close(false),
              catch: acpInternalError,
            }),
          ),
          Effect.tap(() => Effect.sync(() => terminals.delete(request.terminalId))),
          Effect.asVoid,
        ),
      );
    });

  return {
    cwd: sessionFs.cwd,
    initialCwd: sessionFs.initialCwd,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
    registerHandlers,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await Promise.all(
        [...terminals.values()].map((terminal) =>
          terminal.process.close(true).catch(() => undefined),
        ),
      );
      terminals.clear();
      await sessionFs.cleanup();
    },
  };
}
