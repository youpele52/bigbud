import { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import * as EffectAcpErrors from "effect-acp/errors";
import { describe, expect, it } from "vitest";

import { CodexModelSelectionError } from "../../codex/codexAppServerManager.modelSelection.ts";
import {
  mapAcpPromptToAdapterError,
  mapAcpToAdapterError,
} from "../../provider/acp/AcpAdapterSupport.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../../provider/Errors.ts";
import { toRequestError as toClaudeRequestError } from "../../provider/Layers/Claude/Adapter.utils.errors.ts";
import { remapError as remapCliProxyError } from "../../provider/Layers/CliProxy/Adapter.ts";
import {
  toRequestError as toCodexRequestError,
  toStartSessionError as toCodexStartSessionError,
} from "../../provider/Layers/Codex/Adapter.session.shared.ts";
import { toSendTurnError as toCopilotSendTurnError } from "../../provider/Layers/Copilot/Adapter.types.ts";
import { V2HttpStatusError } from "../../provider/Layers/OpencodeV2/Client.errors.ts";
import {
  v2ExecutionFailureClass,
  v2ExecutionIssue,
} from "../../provider/Layers/OpencodeV2/Adapter.execution.errors.ts";
import { V2_DEAD_BACKEND_MESSAGES } from "../../provider/Layers/OpencodeV2/Orchestration.enrollment.deadBackend.ts";
import { requirePiSession } from "../../provider/Layers/Pi/Adapter.methods.session.ts";
import { classifyTurnStartFailure } from "./ProviderTurnFailureClassification.ts";

const THREAD = ThreadId.makeUnsafe("thread-1");
const classify = classifyTurnStartFailure;
/** Builds the error exactly as the OpenCode V2 adapter's `call` wrapper does. */
const v2Error = (cause: unknown) => {
  const issue = v2ExecutionIssue(cause);
  return new ProviderAdapterValidationError({
    provider: "opencodeV2",
    operation: "sendTurn",
    issue,
    failureClass: v2ExecutionFailureClass(cause, issue),
  });
};

describe("turn-start failure classification per provider adapter", () => {
  it("codex", () => {
    expect(classify(toCodexRequestError(THREAD, "turn/start", new Error("unknown session")))).toBe(
      "session-dead",
    );
    expect(
      classify(toCodexRequestError(THREAD, "turn/start", new Error("session is closed"))),
    ).toBe("session-dead");
    const model = new CodexModelSelectionError("unknown-model", "Unknown Codex model 'nope'.");
    expect(classify(toCodexRequestError(THREAD, "turn/start", model))).toBe("invalid-request");
    expect(classify(toCodexRequestError(THREAD, "turn/start", new Error("401 Unauthorized")))).toBe(
      "auth-or-quota",
    );
    // A missing binary is not a dead session: never recovered or forked automatically (D18).
    expect(classify(toCodexStartSessionError(THREAD, new Error("spawn codex ENOENT")))).toBe(
      "provider-unavailable",
    );
  });

  it("claudeAgent", () => {
    expect(classify(toClaudeRequestError(THREAD, "query", new Error("Query closed")))).toBe(
      "session-dead",
    );
    expect(classify(toClaudeRequestError(THREAD, "query", new Error("usage limit reached")))).toBe(
      "auth-or-quota",
    );
    const busy = new ProviderAdapterValidationError({
      provider: "claudeAgent",
      operation: "sendTurn",
      issue:
        "Turn 'turn-1' is already active. Interrupt or wait for it to complete before starting another turn.",
    });
    expect(classify(busy)).toBe("busy");
  });

  it("cliProxy keeps the wrapped Claude error class and explicit class", () => {
    const closed = remapCliProxyError(toClaudeRequestError(THREAD, "query", new Error("closed")));
    expect(closed.provider).toBe("cliProxy");
    expect(classify(closed)).toBe("session-dead");
    const explicit = remapCliProxyError(
      new ProviderAdapterRequestError({
        provider: "claudeAgent",
        method: "query",
        detail: "x",
        failureClass: "invalid-request",
      }),
    );
    expect(classify(explicit)).toBe("invalid-request");
  });

  it("copilot", () => {
    expect(classify(toCopilotSendTurnError(new Error("Session not found: abc")))).toBe(
      "session-dead",
    );
    expect(classify(toCopilotSendTurnError(new Error("Connection is disposed.")))).toBe(
      "session-dead",
    );
    expect(classify(toCopilotSendTurnError(new Error("403 Forbidden")))).toBe("auth-or-quota");
  });

  it.each(["cursor", "devin"] as const)("%s (ACP)", (provider) => {
    const exited = new EffectAcpErrors.AcpProcessExitedError({ code: 1 });
    // A prompt that already started has an uncertain outcome: never auto-resent.
    expect(classify(mapAcpPromptToAdapterError(provider, THREAD, "session/prompt", exited))).toBe(
      "unsafe-to-replay",
    );
    // Outside the prompt (e.g. session setup) a process exit is session-dead.
    expect(classify(mapAcpToAdapterError(provider, THREAD, "session/load", exited))).toBe(
      "session-dead",
    );
    // requireSession before the turn starts.
    expect(classify(new ProviderAdapterSessionNotFoundError({ provider, threadId: THREAD }))).toBe(
      "session-dead",
    );
    const empty = new ProviderAdapterValidationError({
      provider,
      operation: "sendTurn",
      issue: "Turn requires non-empty text or attachments.",
    });
    expect(classify(empty)).toBe("invalid-request");
  });

  it.each(["opencode", "kilocode"] as const)("%s (shared OpenCode V1 session methods)", (p) => {
    // requireSession after a transport failure tore the session record down.
    expect(
      classify(new ProviderAdapterSessionNotFoundError({ provider: p, threadId: THREAD })),
    ).toBe("session-dead");
    const model = new ProviderAdapterValidationError({
      provider: p,
      operation: "sendTurn",
      issue: `Unable to resolve ${p} provider for model 'x'.`,
    });
    expect(classify(model)).toBe("invalid-request");
  });

  it("pi", () => {
    const missing = Effect.runSync(Effect.flip(requirePiSession(new Map(), THREAD)));
    expect(classify(missing)).toBe("session-dead");
    const exited = new ProviderAdapterRequestError({
      provider: "pi",
      method: "prompt",
      detail: "Pi RPC process 'pi' exited (code=1, signal=null).",
    });
    expect(classify(exited)).toBe("session-dead");
  });

  it("opencodeV2", () => {
    expect(classify(v2Error(new V2HttpStatusError(401)))).toBe("auth-or-quota");
    expect(classify(v2Error(new V2HttpStatusError(500)))).toBe("unsafe-to-replay");
    expect(classify(v2Error(new Error(V2_DEAD_BACKEND_MESSAGES.lockUnproved)))).toBe(
      "unsafe-to-replay",
    );
    expect(classify(v2Error(new TypeError("fetch failed")))).toBe("unsafe-to-replay");
    const busy = new Error("V2 native execution is already active; no queued duplicate work.");
    expect(classify(v2Error(busy))).toBe("busy");
  });
});
