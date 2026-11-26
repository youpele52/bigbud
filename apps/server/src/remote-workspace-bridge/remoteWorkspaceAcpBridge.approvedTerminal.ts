import { randomUUID } from "node:crypto";

import { ApprovalRequestId } from "@bigbud/contracts/core/baseSchemas";
import { Effect } from "effect";
import type * as AcpSchema from "effect-acp/schema";

import type { AcpSessionRuntimeShape } from "../provider/acp/AcpSessionRuntime.ts";
import type { AcpTerminalSshOwner } from "./remoteWorkspaceAcpTerminal.owner.ts";
import { createOwnedAcpTerminal } from "./remoteWorkspaceAcpTerminal.owner.ts";
import { acpCommandText, isAcpPwdRequest } from "./remoteWorkspaceAcpTerminal.owner.command.ts";
import type { AcpTerminalApprovalProducer } from "./remoteWorkspaceAcpApproval.ts";
import { AcpRequestError } from "effect-acp/errors";

const internal = (cause: unknown): AcpRequestError =>
  AcpRequestError.internalError(cause instanceof Error ? cause.message : String(cause));
const notFoundError = (terminalId: string): AcpRequestError =>
  AcpRequestError.resourceNotFound(`ACP terminal '${terminalId}' was not found.`);

export interface AcpRemoteTerminal {
  readonly process: import("./remoteWorkspaceAcpTerminal.ts").AcpTerminalProcess;
  readonly outputByteLimit: number;
  readonly waitForExit: Promise<AcpSchema.WaitForTerminalExitResponse>;
  output: string;
  truncated: boolean;
  exitStatus: AcpSchema.TerminalExitStatus | undefined;
}

export interface ApprovedTerminalContext {
  readonly acp: AcpSessionRuntimeShape;
  readonly owner: AcpTerminalSshOwner;
  readonly producer: AcpTerminalApprovalProducer;
  readonly threadId: string;
  readonly sessionEpoch: number;
  readonly callerSessionId: () => string | undefined;
  readonly executionTargetId: string;
  readonly workspaceRoot: string;
  readonly bridgeCwd: string;
  readonly resolveCwd: (cwd: string) => string;
  readonly terminals: Map<string, AcpRemoteTerminal>;
  readonly appendOutput: (terminal: AcpRemoteTerminal, data: string) => void;
  readonly defaultOutputByteLimit: number;
}

/** Registers the approved direct-terminal handlers; only a composed producer reaches this. */
export function registerApprovedTerminalHandlers(context: ApprovedTerminalContext) {
  const requireTerminal = (
    terminalId: string,
  ): Effect.Effect<AcpRemoteTerminal, AcpRequestError> => {
    const terminal = context.terminals.get(terminalId);
    return terminal ? Effect.succeed(terminal) : Effect.fail(notFoundError(terminalId));
  };
  return Effect.gen(function* () {
    yield* context.acp.handleCreateTerminal((request) =>
      Effect.tryPromise({
        try: async () => {
          const sessionId = context.callerSessionId();
          if (!sessionId) throw internal(new Error("ACP session is not bound."));
          const cwd = request.cwd ? context.resolveCwd(request.cwd) : context.workspaceRoot;
          const issued = context.producer.issue({
            requestId: ApprovalRequestId.makeUnsafe(randomUUID()),
            threadId: context.threadId as never,
            sessionEpoch: context.sessionEpoch,
            acpSessionId: sessionId,
            cwd,
            // U21: any command but the fixed `pwd` is approved as its exact text.
            ...(isAcpPwdRequest({
              command: request.command,
              args: request.args ?? [],
              environment: request.env ?? [],
            })
              ? {}
              : { command: acpCommandText(request.command, request.args ?? []) }),
          });
          const terminalId = randomUUID();
          const process = await createOwnedAcpTerminal(
            {
              executionTargetId: context.executionTargetId,
              workspaceRoot: context.workspaceRoot,
              cwd,
              command: request.command,
              args: request.args ?? [],
              ...(request.env ? { environment: request.env } : {}),
            },
            {
              kind: "selected",
              owner: context.owner,
              identity: issued.identity,
              approval: issued.approval,
              generation: context.producer.generation(),
              signal: new AbortController().signal,
            },
          );
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
            outputByteLimit: request.outputByteLimit ?? context.defaultOutputByteLimit,
            waitForExit,
            output: "",
            truncated: false,
            exitStatus: undefined,
          };
          process.onData((data) => context.appendOutput(terminal, data));
          process.onExit((event) => {
            const exitStatus = {
              exitCode: event.signal === null ? event.exitCode : null,
              signal: event.signal === null ? null : String(event.signal),
            };
            terminal.exitStatus = exitStatus;
            resolveExit(exitStatus);
          });
          process.onError((error) => rejectExit(error));
          context.terminals.set(terminalId, terminal);
          return { terminalId };
        },
        catch: internal,
      }),
    );
    yield* context.acp.handleTerminalOutput((request) =>
      requireTerminal(request.terminalId).pipe(
        Effect.map((terminal) => ({
          output: terminal.output,
          truncated: terminal.truncated,
          ...(terminal.exitStatus ? { exitStatus: terminal.exitStatus } : {}),
        })),
      ),
    );
    yield* context.acp.handleTerminalWaitForExit((request) =>
      requireTerminal(request.terminalId).pipe(
        Effect.flatMap((terminal) =>
          Effect.tryPromise({
            try: () => terminal.waitForExit,
            catch: internal,
          }),
        ),
      ),
    );
    yield* context.acp.handleTerminalKill((request) =>
      requireTerminal(request.terminalId).pipe(
        Effect.tap((terminal) => Effect.sync(() => terminal.process.kill("SIGTERM"))),
        Effect.asVoid,
      ),
    );
    yield* context.acp.handleTerminalRelease((request) =>
      requireTerminal(request.terminalId).pipe(
        Effect.flatMap((terminal) =>
          Effect.tryPromise({
            try: () => terminal.process.close(false),
            catch: internal,
          }),
        ),
        Effect.tap(() => Effect.sync(() => context.terminals.delete(request.terminalId))),
        Effect.asVoid,
      ),
    );
  });
}
