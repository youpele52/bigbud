import { CommandId, ThreadId, type ClientOrchestrationCommand } from "@bigbud/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  beginMobileComposerDraftLease,
  clearSubmittedMobileComposerDraftIfRevision,
  createMobileComposerDraft,
  forgetMobileComposerDraft,
  makeMobileComposerDraftIdentity,
  readMobileComposerDraft,
  writeMobileComposerDraftWithLease,
  writeMobileComposerDraft,
} from "./mobileComposerDraft";

function createSessionStorageMock() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
    values,
  };
}

type TestSessionStorage = ReturnType<typeof createSessionStorageMock>;
let testStorage: TestSessionStorage;

const identity = makeMobileComposerDraftIdentity({
  backendBaseUrl: "https://desktop.example/mobile/",
  sessionId: "session-1",
  threadId: "thread-1",
});

describe("mobile composer draft storage", () => {
  beforeEach(() => {
    testStorage = createSessionStorageMock();
    vi.stubGlobal("sessionStorage", testStorage);
  });

  it("isolates records by normalized backend origin and session", () => {
    const draft = createMobileComposerDraft({
      threadId: ThreadId.makeUnsafe("thread-1"),
      prompt: "Keep this draft",
    });
    expect(writeMobileComposerDraft(identity, draft).ok).toBe(true);
    expect(readMobileComposerDraft(identity).draft?.prompt).toBe("Keep this draft");
    expect(readMobileComposerDraft({ ...identity, sessionId: "other-session" }).draft).toBeNull();
    expect(
      readMobileComposerDraft({
        ...identity,
        backendOrigin: "https://other-desktop.example",
      }).draft,
    ).toBeNull();
    const storedKey = Array.from(testStorage.values.keys())[0];
    expect(storedKey).not.toContain("token");
  });

  it("quarantines malformed data without throwing", () => {
    const draft = createMobileComposerDraft({ threadId: ThreadId.makeUnsafe("thread-1") });
    writeMobileComposerDraft(identity, draft);
    const storedKey = Array.from(testStorage.values.keys())[0];
    testStorage.setItem(storedKey!, "{bad json");
    expect(readMobileComposerDraft(identity).draft).toBeNull();
    expect(readMobileComposerDraft(identity).issue).toBe("malformed");
  });

  it("keeps an in-memory draft when storage is denied or full", () => {
    const draft = createMobileComposerDraft({
      threadId: ThreadId.makeUnsafe("thread-1"),
      prompt: "Do not lose this",
    });
    vi.stubGlobal("sessionStorage", {
      ...testStorage,
      setItem: () => {
        throw new Error("storage denied");
      },
    });
    expect(writeMobileComposerDraft(identity, draft)).toEqual({
      ok: false,
      issue: "unavailable",
    });
    expect(readMobileComposerDraft(identity).draft?.prompt).toBe("Do not lose this");

    vi.stubGlobal("sessionStorage", {
      ...testStorage,
      setItem: () => {
        throw new DOMException("storage full", "QuotaExceededError");
      },
    });
    const quotaDraft = { ...draft, prompt: "Still do not lose this" };
    expect(writeMobileComposerDraft(identity, quotaDraft)).toEqual({
      ok: false,
      issue: "quota",
    });
    expect(readMobileComposerDraft(identity).draft?.prompt).toBe("Still do not lose this");
  });

  it("clears a submitted record only when the draft revision still matches", () => {
    const command = {
      type: "thread.turn.start" as const,
      commandId: CommandId.makeUnsafe("command-1"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
      runtimeMode: "full-access",
      interactionMode: "plan",
      modelSelection: { provider: "codex", model: "gpt-5" },
      message: {
        messageId: "message-1" as never,
        role: "user",
        text: "draft",
        attachments: [],
      },
    } satisfies ClientOrchestrationCommand;
    const draft = {
      ...createMobileComposerDraft({
        threadId: ThreadId.makeUnsafe("thread-1"),
        prompt: "newer typing",
      }),
      revision: 3,
      submitted: {
        command,
        submittedRevision: 2,
        submittedAt: command.createdAt,
        deadlineAt: 100,
        status: "accepted" as const,
      },
    };
    expect(clearSubmittedMobileComposerDraftIfRevision(draft, 2).prompt).toBe("newer typing");
    const cleared = clearSubmittedMobileComposerDraftIfRevision({ ...draft, revision: 2 }, 2);
    expect(cleared.prompt).toBe("");
    expect(cleared.submitted).toBeNull();

    const stopped = clearSubmittedMobileComposerDraftIfRevision(
      {
        ...draft,
        revision: 2,
        submitted: {
          ...draft.submitted!,
          command: {
            type: "thread.turn.interrupt" as const,
            commandId: command.commandId,
            threadId: command.threadId,
            createdAt: command.createdAt,
          },
        },
      },
      2,
    );
    expect(stopped.prompt).toBe("newer typing");
    expect(stopped.submitted).toBeNull();
  });

  it("invalidates late writes after Forget while allowing a new owner to acquire a lease", () => {
    const draft = createMobileComposerDraft({
      threadId: ThreadId.makeUnsafe("thread-1"),
      prompt: "private draft",
    });
    const lease = beginMobileComposerDraftLease(identity);
    expect(writeMobileComposerDraftWithLease(lease, draft).ok).toBe(true);
    expect(forgetMobileComposerDraft(identity)).toBe(true);
    expect(writeMobileComposerDraftWithLease(lease, draft).ok).toBe(false);
    expect(readMobileComposerDraft(identity).draft).toBeNull();
    const replacement = beginMobileComposerDraftLease(identity);
    expect(writeMobileComposerDraftWithLease(replacement, draft).ok).toBe(true);
    expect(readMobileComposerDraft(identity).draft?.prompt).toBe("private draft");
  });
});
