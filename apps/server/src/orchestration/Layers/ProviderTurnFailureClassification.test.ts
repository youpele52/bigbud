import { Cause } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  ProviderSessionNotFoundError,
  ProviderValidationError,
} from "../../provider/Errors.ts";
import { V2_DEAD_BACKEND_MESSAGES } from "../../provider/Layers/OpencodeV2/Orchestration.enrollment.deadBackend.ts";
import {
  classifyTurnStartFailure,
  isProviderTurnBusyCause,
} from "./ProviderTurnFailureClassification.ts";

const request = (detail: string) =>
  new ProviderAdapterRequestError({ provider: "codex", method: "turn/start", detail });
const validation = (issue: string) =>
  new ProviderAdapterValidationError({ provider: "codex", operation: "sendTurn", issue });

describe("classifyTurnStartFailure", () => {
  it.each([
    ["busy", validation("Turn 'turn-1' is already active. Interrupt or wait.")],
    ["busy", new ProviderValidationError({ operation: "x", issue: "has ongoing provider work" })],
    ["context-limit", request("maximum context length exceeded for this model")],
    ["session-dead", new ProviderAdapterSessionNotFoundError({ provider: "pi", threadId: "t" })],
    ["session-dead", new ProviderAdapterSessionClosedError({ provider: "codex", threadId: "t" })],
    [
      "session-dead",
      new ProviderAdapterProcessError({ provider: "pi", threadId: "t", detail: "x" }),
    ],
    ["session-dead", new ProviderSessionNotFoundError({ threadId: "t" })],
    ["session-dead", request("Pi RPC process 'pi' exited (code=1, signal=null).")],
    ["session-dead", request("Connection is closed.")],
    ["session-dead", request("read ECONNRESET")],
    [
      "session-dead",
      validation("Cannot recover thread 't' because no provider resume state is persisted."),
    ],
    ["auth-or-quota", request("401 Unauthorized")],
    ["auth-or-quota", request("Rate limit reached; retry later")],
    ["auth-or-quota", request("Insufficient credit balance; check billing")],
    ["invalid-request", validation("Turn requires non-empty text or attachments.")],
    ["invalid-request", new ProviderValidationError({ operation: "x", issue: "bad attachment" })],
    [
      "unsafe-to-replay",
      validation(
        "OpenCode v2 operation failed or remains unconfirmed; no automatic resend or provider fallback.",
      ),
    ],
    ["unknown", request("Something unexpected happened")],
    ["unknown", new Error("boom")],
  ] as const)("classifies %s", (expected, error) => {
    expect(classifyTurnStartFailure(error)).toBe(expected);
    expect(classifyTurnStartFailure(Cause.fail(error))).toBe(expected);
  });

  it("prefers the adapter's explicit class over every pattern", () => {
    const explicit = new ProviderAdapterRequestError({
      provider: "codex",
      method: "turn/start",
      detail: "401 Unauthorized: session is closed",
      failureClass: "session-dead",
    });
    expect(classifyTurnStartFailure(explicit)).toBe("session-dead");
    const closedButUnsafe = new ProviderAdapterSessionClosedError({
      provider: "cursor",
      threadId: "t",
      failureClass: "unsafe-to-replay",
    });
    expect(classifyTurnStartFailure(closedButUnsafe)).toBe("unsafe-to-replay");
  });

  it("checks typed errors before the session-dead text fallback", () => {
    expect(classifyTurnStartFailure(validation("the session is closed for edits"))).toBe(
      "invalid-request",
    );
    expect(classifyTurnStartFailure(request("the session is closed"))).toBe("session-dead");
  });

  it("classifies every OpenCode V2 dead-backend refusal as unsafe-to-replay, never busy", () => {
    const texts = [
      V2_DEAD_BACKEND_MESSAGES.nativeActive,
      V2_DEAD_BACKEND_MESSAGES.ownerAlive(4242),
      V2_DEAD_BACKEND_MESSAGES.lockUnproved,
      V2_DEAD_BACKEND_MESSAGES.nativeUnconfirmed,
    ];
    for (const text of texts) {
      const error = new ProviderAdapterValidationError({
        provider: "opencodeV2",
        operation: "sendTurn",
        issue: text,
      });
      expect(classifyTurnStartFailure(error)).toBe("unsafe-to-replay");
      expect(isProviderTurnBusyCause(Cause.fail(error))).toBe(false);
    }
  });
});
