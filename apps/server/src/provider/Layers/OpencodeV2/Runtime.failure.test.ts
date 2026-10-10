import { expect, it } from "vitest";
import type { SessionMessageAssistant, SessionStructuredError } from "@opencode/client";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { v2NativeFailureMessage } from "./Runtime.failure.ts";

const selection = {
  provider: "opencodeV2",
  subProviderID: "opencode",
  model: "synthetic-model",
} as const;
const threadId = ThreadId.makeUnsafe("native-provider-failure");

it.each([
  {
    error: {
      type: "provider.auth",
      status: 403,
      message: "OpenCode's free tier can only be used from within OpenCode",
    },
    reason: "free-tier request context",
  },
  {
    error: {
      type: "provider.invalid-request",
      status: 410,
      message: "Model synthetic-model has been deprecated.",
    },
    reason: "deprecated",
  },
  {
    error: {
      type: "provider.invalid-request",
      status: 400,
      message: "Upstream request failed: Model is unavailable.",
    },
    reason: "unavailable",
  },
  {
    error: {
      type: "provider.auth",
      status: 401,
      message: "Authorization: Bearer private-auth-value",
    },
    reason: "authentication",
  },
])(
  "surfaces the safe native $error.status reason after exact terminal correlation, never response body or automatic resend",
  async ({ error, reason }) => {
    await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
      http.autoComplete = false;
      http.models.push({ ...http.models[0]!, providerID: "opencode" });
      await runtime.start({
        threadId,
        modelSelection: selection,
        cwd: directory,
        runtimeMode: "full-access",
      });
      const input = {
        threadId,
        requestMessageId: MessageId.makeUnsafe("provider-failed-request"),
        input: "synthetic only",
      };
      await runtime.send(input);
      const nativeId = runtime.get(threadId).native.id;
      http.fail = true;
      http.complete(nativeId, "");
      const assistant = http.messages
        .get(nativeId)!
        .find((message): message is SessionMessageAssistant => message.type === "assistant")!;
      assistant.error = {
        ...error,
        response: { body: "private vendor response Authorization: Bearer private-body-value" },
      } as SessionStructuredError;
      await runtime.reconcile(runtime.get(threadId));
      const terminal = events.find((event) => event.type === "turn.completed");
      expect(terminal?.payload).toMatchObject({
        state: "failed",
        errorMessage: expect.stringContaining(reason),
      });
      expect(terminal?.payload).toMatchObject({
        errorMessage: expect.stringContaining(`HTTP ${error.status}`),
      });
      expect(JSON.stringify(events)).not.toContain("private-");
      const prompts = () =>
        http.calls.filter((call) => call.method === "POST" && call.pathname.endsWith("/prompt"));
      expect(prompts()).toHaveLength(1);
      await runtime.send(input);
      expect(prompts()).toHaveLength(1);
    });
  },
);

it("does not echo arbitrary native error fields or pretend an invalid HTTP status is trustworthy", () => {
  const message = {
    model: { providerID: "synthetic-provider", id: "long\nmodel" },
    error: {
      type: "private-type-value",
      status: Number.NaN,
      message: "private-message-value https://private-endpoint?token=private-token-value",
      response: { body: "private-body-value" },
    },
  } as SessionMessageAssistant;
  const result = v2NativeFailureMessage(message);
  expect(result).not.toContain("private-");
  expect(result).not.toContain("HTTP");
  expect(result).not.toContain("\n");
  expect(result.length).toBeLessThanOrEqual(512);
  expect(v2NativeFailureMessage(undefined)).toBe("OpenCode v2 native execution failed.");
});
