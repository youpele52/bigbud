import type { CodexSessionContext } from "./codexAppServerManager.types.ts";
import { classifyCodexStderrLine } from "./codexStderrClassifier.ts";
import { closeCodexTransport } from "./codexAppServerManager.transport.ts";
import { killChildTree } from "./codexAppServerManager.utils.ts";
import {
  PROVIDER_STDIO_MAX_LINE_BYTES,
  ProviderStdioLineTooLongError,
  createLineLengthGuard,
} from "../provider/providerStdioLineLimit.ts";

export function attachProcessListeners(
  context: CodexSessionContext,
  callbacks: {
    onStdoutLine: (context: CodexSessionContext, line: string) => void;
    emitNotificationEvent: (context: CodexSessionContext, method: string, message: string) => void;
    updateSession: (
      context: CodexSessionContext,
      updates: Partial<import("@bigbud/contracts").ProviderSession>,
    ) => void;
    emitErrorEvent: (context: CodexSessionContext, method: string, message: string) => void;
    emitLifecycleEvent: (context: CodexSessionContext, method: string, message: string) => void;
    sessions: Map<import("@bigbud/contracts").ThreadId, CodexSessionContext>;
  },
): void {
  context.output.on("line", (line) => callbacks.onStdoutLine(context, line));

  context.child.stderr.on("data", (chunk: Buffer) => {
    for (const rawLine of chunk.toString().split(/\r?\n/g)) {
      const classified = classifyCodexStderrLine(rawLine);
      if (classified)
        callbacks.emitNotificationEvent(context, "process/stderr", classified.message);
    }
  });

  const rejectPending = (error: Error): void => {
    context.mcpReadiness?.cancel(error);
    closeCodexTransport(context, error);
  };

  const onError = (error: Error) => {
    if (context.stopping || callbacks.sessions.get(context.session.threadId) !== context) return;
    const message = error.message || "codex app-server process errored.";
    rejectPending(error);
    callbacks.updateSession(context, { status: "error", lastError: message });
    callbacks.emitErrorEvent(context, "process/error", message);
  };
  context.child.on("error", onError);
  context.child.stdin.on("error", onError);

  // F-B5: `readline` has no line limit; an oversized record ends the session as a protocol error.
  const stdoutGuard = createLineLengthGuard();
  const onStdoutData = (chunk: Buffer | string) => {
    if (!stdoutGuard.observe(chunk)) return;
    context.child.stdout.off("data", onStdoutData);
    context.output.close();
    onError(new ProviderStdioLineTooLongError("Codex app-server", PROVIDER_STDIO_MAX_LINE_BYTES));
    killChildTree(context.child);
  };
  context.child.stdout.on("data", onStdoutData);

  context.child.on("exit", (code, signal) => {
    const message = `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
    rejectPending(new Error(message));
    if (context.stopping || callbacks.sessions.get(context.session.threadId) !== context) return;
    context.stopping = true;
    context.output.close();
    callbacks.updateSession(context, {
      status: "closed",
      activeTurnId: undefined,
      lastError: code === 0 ? context.session.lastError : message,
    });
    callbacks.emitLifecycleEvent(context, "session/exited", message);
    void context.cleanupRemoteWorkspaceBridge?.().catch(() => undefined);
    sessionsDelete(callbacks.sessions, context);
  });

  context.child.on("close", () => {
    rejectPending(new Error("Codex app-server transport closed."));
    if (!context.stopping && context.mcpReadiness) {
      context.mcpReadiness.cancel(new Error("Codex app-server transport closed."));
    }
  });
}

function sessionsDelete(
  sessions: Map<import("@bigbud/contracts").ThreadId, CodexSessionContext>,
  context: CodexSessionContext,
): void {
  if (sessions.get(context.session.threadId) === context) {
    sessions.delete(context.session.threadId);
  }
}
