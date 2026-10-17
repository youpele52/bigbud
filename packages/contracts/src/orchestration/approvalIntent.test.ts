import { Schema } from "effect";
import { expect, it } from "vitest";
import { ApprovalExecutionIntent, APPROVAL_INTENT_MAX_CHARS } from "./approvalIntent";
import { RequestOpenedPayload } from "./providerRuntime.payloads";

it("canonical request retains complete bounded intent without changing legacy metadata and rejects over-limit content", () => {
  const intent = {
    format: "json",
    content: JSON.stringify({
      action: "shell",
      root: "/workspace",
      command: "echo " + "x".repeat(400),
    }),
  } as const;
  const input = {
    requestType: "command_execution_approval",
    executionIntent: intent,
    detail: "legacy detail",
    sessionApprovalAvailable: false,
    args: { fingerprint: "exact" },
  } as const;
  expect(Schema.decodeUnknownSync(RequestOpenedPayload)(input)).toEqual(input);
  expect(
    Schema.decodeUnknownSync(RequestOpenedPayload)({
      requestType: input.requestType,
      detail: input.detail,
    }),
  ).toEqual({ requestType: input.requestType, detail: input.detail });
  expect(() =>
    Schema.decodeUnknownSync(ApprovalExecutionIntent)({
      format: "json",
      content: "x".repeat(APPROVAL_INTENT_MAX_CHARS + 1),
    }),
  ).toThrow();
});
