import { beforeEach, describe, expect, it, vi } from "vitest";

import { useStore } from "../stores/main";

vi.mock("../rpc/nativeApi", () => ({ readNativeApi: vi.fn(() => undefined) }));

import { HandoffError, HANDOFF_SKILL_PROMPT, waitForHandoffDocument } from "./handoff";
import { setThreadState, THREAD_ID } from "./handoff.test.shared";

function setTruncatedReply() {
  setThreadState({
    messages: [
      { id: "m1", role: "user", text: HANDOFF_SKILL_PROMPT, streaming: false, createdAt: "1" },
      {
        id: "m2",
        role: "assistant",
        text: "preview without the document",
        textTruncated: true,
        streaming: false,
        createdAt: "2",
      } as never,
    ],
    session: { status: "ready", activeTurnId: null },
  });
}

describe("waitForHandoffDocument with a truncated reply", () => {
  beforeEach(() => {
    useStore.setState({ threads: [], sidebarThreadsById: {} } as never);
  });

  it("extracts the document from the full text, reading it once", async () => {
    setTruncatedReply();
    const resolveMessageText = vi.fn(
      async () => "intro\n<handoff_document>\n# Handoff\nfull body\n</handoff_document>",
    );

    await expect(
      waitForHandoffDocument(THREAD_ID, {
        requestMessageId: "m1",
        timeoutMs: 5_000,
        resolveMessageText,
      }),
    ).resolves.toBe("# Handoff\nfull body");
    expect(resolveMessageText).toHaveBeenCalledTimes(1);
  });

  it("fails rather than using the preview when the full text cannot be read", async () => {
    setTruncatedReply();
    const resolveMessageText = vi.fn(async () => {
      throw new Error("offline");
    });

    const result = waitForHandoffDocument(THREAD_ID, {
      requestMessageId: "m1",
      timeoutMs: 5_000,
      resolveMessageText,
    });
    await expect(result).rejects.toBeInstanceOf(HandoffError);
    await expect(result).rejects.toThrow("offline");
  });
});
