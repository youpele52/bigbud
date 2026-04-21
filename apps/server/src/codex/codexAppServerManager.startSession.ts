/**
 * Session startup logic for CodexAppServerManager — extracted to keep the
 * manager class focused on session lifecycle bookkeeping.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

import { EventId, ThreadId, type ProviderEvent, type ProviderSession } from "@bigbud/contracts";
import { Effect } from "effect";

import { readCodexAccountSnapshot, resolveCodexModelForAccount } from "../provider/codexAccount";
import { buildCodexInitializeParams } from "../provider/codexAppServer";
import { normalizeCodexModelSlug } from "./codexModeInstructions";
import { isRecoverableThreadResumeError } from "./codexStderrClassifier";
import { assertSupportedCodexCliVersion } from "./codexVersionCheck";
import {
  type CodexAppServerStartSessionInput,
  type CodexSessionContext,
} from "./codexAppServerManager.types";
import { mapCodexRuntimeMode, readResumeThreadId } from "./codexAppServerManager.utils";

export interface StartSessionOps {
  readonly runPromise: (effect: Effect.Effect<unknown, never>) => Promise<unknown>;
  readonly sessions: Map<ThreadId, CodexSessionContext>;
  readonly sendRequest: <T>(
    ctx: CodexSessionContext,
    method: string,
    params: unknown,
    timeoutMs?: number,
  ) => Promise<T>;
  readonly writeMessage: (ctx: CodexSessionContext, message: unknown) => void;
  readonly attachProcessListeners: (ctx: CodexSessionContext) => void;
  readonly updateSession: (ctx: CodexSessionContext, updates: Partial<ProviderSession>) => void;
  readonly emitEvent: (event: ProviderEvent) => void;
  readonly emitLifecycleEvent: (ctx: CodexSessionContext, method: string, message: string) => void;
  readonly emitErrorEvent: (ctx: CodexSessionContext, method: string, message: string) => void;
  readonly stopSession: (threadId: ThreadId) => void;
}

export async function startSession(
  input: CodexAppServerStartSessionInput,
  ops: StartSessionOps,
): Promise<ProviderSession> {
  const threadId = input.threadId;
  const now = new Date().toISOString();
  let context: CodexSessionContext | undefined;

  try {
    const resolvedCwd = input.cwd ?? process.cwd();

    const session: ProviderSession = {
      provider: "codex",
      status: "connecting",
      runtimeMode: input.runtimeMode,
      model: normalizeCodexModelSlug(input.model),
      cwd: resolvedCwd,
      threadId,
      createdAt: now,
      updatedAt: now,
    };

    const codexBinaryPath = input.binaryPath;
    const codexHomePath = input.homePath;
    assertSupportedCodexCliVersion({
      binaryPath: codexBinaryPath,
      cwd: resolvedCwd,
      ...(codexHomePath ? { homePath: codexHomePath } : {}),
    });
    const child = spawn(codexBinaryPath, ["app-server"], {
      cwd: resolvedCwd,
      env: {
        ...process.env,
        ...(codexHomePath ? { CODEX_HOME: codexHomePath } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    const output = readline.createInterface({ input: child.stdout });

    context = {
      session,
      account: {
        type: "unknown",
        planType: null,
        sparkEnabled: true,
      },
      child,
      output,
      pending: new Map(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      nextRequestId: 1,
      stopping: false,
    };

    ops.sessions.set(threadId, context);
    ops.attachProcessListeners(context);

    ops.emitLifecycleEvent(context, "session/connecting", "Starting codex app-server");

    await ops.sendRequest(context, "initialize", buildCodexInitializeParams());

    ops.writeMessage(context, { method: "initialized" });
    try {
      const modelListResponse = await ops.sendRequest(context, "model/list", {});
      console.log("codex model/list response", modelListResponse);
    } catch (error) {
      console.log("codex model/list failed", error);
    }
    try {
      const accountReadResponse = await ops.sendRequest(context, "account/read", {});
      console.log("codex account/read response", accountReadResponse);
      context.account = readCodexAccountSnapshot(accountReadResponse);
      console.log("codex subscription status", {
        type: context.account.type,
        planType: context.account.planType,
        sparkEnabled: context.account.sparkEnabled,
      });
    } catch (error) {
      console.log("codex account/read failed", error);
    }

    const normalizedModel = resolveCodexModelForAccount(
      normalizeCodexModelSlug(input.model),
      context.account,
    );
    const sessionOverrides = {
      model: normalizedModel ?? null,
      ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
      cwd: input.cwd ?? null,
      ...mapCodexRuntimeMode(input.runtimeMode ?? "full-access"),
    };

    const threadStartParams = {
      ...sessionOverrides,
      experimentalRawEvents: false,
    };
    const resumeThreadId = readResumeThreadId(input);
    ops.emitLifecycleEvent(
      context,
      "session/threadOpenRequested",
      resumeThreadId
        ? `Attempting to resume thread ${resumeThreadId}.`
        : "Starting a new Codex thread.",
    );
    await Effect.logInfo("codex app-server opening thread", {
      threadId,
      requestedRuntimeMode: input.runtimeMode,
      requestedModel: normalizedModel ?? null,
      requestedCwd: resolvedCwd,
      resumeThreadId: resumeThreadId ?? null,
    }).pipe(ops.runPromise);

    let threadOpenMethod: "thread/start" | "thread/resume" = "thread/start";
    let threadOpenResponse: unknown;
    if (resumeThreadId) {
      try {
        threadOpenMethod = "thread/resume";
        threadOpenResponse = await ops.sendRequest(context, "thread/resume", {
          ...sessionOverrides,
          threadId: resumeThreadId,
        });
      } catch (error) {
        if (!isRecoverableThreadResumeError(error)) {
          ops.emitErrorEvent(
            context,
            "session/threadResumeFailed",
            error instanceof Error ? error.message : "Codex thread resume failed.",
          );
          await Effect.logWarning("codex app-server thread resume failed", {
            threadId,
            requestedRuntimeMode: input.runtimeMode,
            resumeThreadId,
            recoverable: false,
            cause: error instanceof Error ? error.message : String(error),
          }).pipe(ops.runPromise);
          throw error;
        }

        threadOpenMethod = "thread/start";
        ops.emitLifecycleEvent(
          context,
          "session/threadResumeFallback",
          `Could not resume thread ${resumeThreadId}; started a new thread instead.`,
        );
        await Effect.logWarning("codex app-server thread resume fell back to fresh start", {
          threadId,
          requestedRuntimeMode: input.runtimeMode,
          resumeThreadId,
          recoverable: true,
          cause: error instanceof Error ? error.message : String(error),
        }).pipe(ops.runPromise);
        threadOpenResponse = await ops.sendRequest(context, "thread/start", threadStartParams);
      }
    } else {
      threadOpenMethod = "thread/start";
      threadOpenResponse = await ops.sendRequest(context, "thread/start", threadStartParams);
    }

    const threadOpenRecord = readObjectHelper(threadOpenResponse);
    const threadIdRaw =
      readStringHelper(readObjectHelper(threadOpenRecord, "thread"), "id") ??
      readStringHelper(threadOpenRecord, "threadId");
    if (!threadIdRaw) {
      throw new Error(`${threadOpenMethod} response did not include a thread id.`);
    }
    const providerThreadId = threadIdRaw;

    ops.updateSession(context, {
      status: "ready",
      resumeCursor: { threadId: providerThreadId },
    });
    ops.emitLifecycleEvent(
      context,
      "session/threadOpenResolved",
      `Codex ${threadOpenMethod} resolved.`,
    );
    await Effect.logInfo("codex app-server thread open resolved", {
      threadId,
      threadOpenMethod,
      requestedResumeThreadId: resumeThreadId ?? null,
      resolvedThreadId: providerThreadId,
      requestedRuntimeMode: input.runtimeMode,
    }).pipe(ops.runPromise);
    ops.emitLifecycleEvent(context, "session/ready", `Connected to thread ${providerThreadId}`);
    return { ...context.session };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start Codex session.";
    if (context) {
      ops.updateSession(context, {
        status: "error",
        lastError: message,
      });
      ops.emitErrorEvent(context, "session/startFailed", message);
      ops.stopSession(threadId);
    } else {
      ops.emitEvent({
        id: EventId.makeUnsafe(randomUUID()),
        kind: "error",
        provider: "codex",
        threadId,
        createdAt: new Date().toISOString(),
        method: "session/startFailed",
        message,
      });
    }
    throw new Error(message, { cause: error });
  }
}

// ---------------------------------------------------------------------------
// Local helpers (mirror the class's private readObject/readString)
// ---------------------------------------------------------------------------

function readObjectHelper(value: unknown, key?: string): Record<string, unknown> | undefined {
  const target =
    key === undefined
      ? value
      : value && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined;

  if (!target || typeof target !== "object") {
    return undefined;
  }

  return target as Record<string, unknown>;
}

function readStringHelper(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}
