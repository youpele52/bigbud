import { MessageId, ThreadId } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import { peekAutomationRequest, readAutomationRequest } from "./automation";

const threadId = ThreadId.makeUnsafe("thread-1");
const id = MessageId.makeUnsafe("message-1");
const requestBlock = `<automation_request>${JSON.stringify({
  title: "Daily",
  prompt: "Summarise",
  scheduleKind: "custom",
  scheduleLabel: "Daily",
  cronExpression: "0 9 * * *",
  timezone: "UTC",
})}</automation_request>`;

describe("automation requests in truncated replies", () => {
  it("reads a complete reply synchronously", () => {
    expect(peekAutomationRequest({ text: requestBlock })).toMatchObject({ title: "Daily" });
  });

  it("does not parse a preview", () => {
    expect(peekAutomationRequest({ text: "preview", textTruncated: true })).toBe("unread");
  });

  it("parses the request from the full text of a truncated reply", async () => {
    const resolveText = vi.fn(async () => `${"x".repeat(10)}${requestBlock}`);
    await expect(
      readAutomationRequest(threadId, { id, text: "x", textTruncated: true }, resolveText),
    ).resolves.toMatchObject({ title: "Daily", cronExpression: "0 9 * * *" });
    expect(resolveText).toHaveBeenCalledWith(threadId, { id, text: "x", textTruncated: true });
  });
});
