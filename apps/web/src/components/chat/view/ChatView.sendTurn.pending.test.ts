import { expect, it, vi } from "vitest";
import { ApprovalRequestId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { toastManager } from "../../ui/toast";
import { respondToPendingUserInput } from "./ChatView.sendTurn.actions.pending";
import { claimComposerSend, type PendingComposerSend } from "./ChatView.sendTurn.pending";
import type { UseOnSendInput } from "./ChatView.sendTurn.types";

vi.mock("../../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("./ChatView.sendTurn.helpers", () => ({
  buildTurnAttachments: async (images: { id: string }[]) =>
    images.map((image) => ({ type: "image", id: image.id })),
}));

function input(prompt: string, threadId = "owner"): UseOnSendInput {
  return {
    activeThread: { id: ThreadId.makeUnsafe(threadId) },
    promptRef: { current: prompt },
    composerImages: [],
    composerImagesRef: { current: [] },
    composerFiles: [],
    composerFilesRef: { current: [] },
    composerAnnotations: [],
    composerAnnotationsRef: { current: [] },
    composerTerminalContexts: [],
    composerTerminalContextsRef: { current: [] },
  } as unknown as UseOnSendInput;
}

it("keeps the direct-send exclusion while a distinct queued send completes", () => {
  const pending = new Set<PendingComposerSend>();
  const direct = claimComposerSend(pending, input("Direct"), false)!;
  const queued = claimComposerSend(pending, input("Queue"), true)!;
  expect(queued).not.toBeNull();
  expect(claimComposerSend(pending, input("Another direct"), false)).toBeNull();
  queued.release();
  expect(claimComposerSend(pending, input("Another direct"), false)).toBeNull();
  direct.release();
  expect(claimComposerSend(pending, input("Another direct"), false)).not.toBeNull();
});

it("deduplicates unconsumed content but allows intentionally repeating a consumed queue draft", () => {
  const pending = new Set<PendingComposerSend>();
  const original = input("Same instruction");
  const first = claimComposerSend(pending, original, true)!;
  expect(claimComposerSend(pending, input("Same instruction"), true)).toBeNull();
  first.consume();
  expect(claimComposerSend(pending, input("Same instruction"), true)).not.toBeNull();
});

it("scopes direct exclusion and content deduplication to the original thread", () => {
  const pending = new Set<PendingComposerSend>();
  claimComposerSend(pending, input("Instruction", "first"), false);
  expect(claimComposerSend(pending, input("Instruction", "second"), false)).not.toBeNull();
});

it("admits a distinct attachment draft while an earlier queue preflight is pending", () => {
  const pending = new Set<PendingComposerSend>();
  const original = input("Same text");
  claimComposerSend(pending, original, true);
  const newer = input("Same text");
  newer.composerFilesRef.current = [{ id: "new-file" }] as UseOnSendInput["composerFiles"];
  expect(claimComposerSend(pending, newer, true)).not.toBeNull();
});

const requestId = ApprovalRequestId.makeUnsafe("panel-request");
function respondInput(
  calls: string[],
  overrides: Partial<Parameters<typeof respondToPendingUserInput>[0]> = {},
): Parameters<typeof respondToPendingUserInput>[0] {
  return {
    activePendingUserInput: {
      requestId,
      createdAt: "2026-11-13T00:00:00.000Z",
      questions: [
        {
          id: "deploy",
          header: "Deploy target",
          question: "Where?",
          options: [{ label: "Staging", description: "Staging" }],
          multiSelect: false,
        },
      ],
    },
    activePendingUserInputRequestId: requestId,
    activePendingDraftAnswers: { deploy: { selectedOptionLabels: ["Staging"] } },
    activeQuestionId: "deploy",
    promptText: "behind the flag",
    images: [{ id: "shot" }] as unknown as UseOnSendInput["composerImages"],
    files: [],
    onRespondToUserInput: vi.fn(async () => void calls.push("answer")),
    submitQueuedComposerPrompt: vi.fn(async () => (calls.push("follow-up"), "queued" as const)),
    resetComposerDraft: vi.fn(() => void calls.push("reset")),
    ...overrides,
  };
}

it("resolves the answer first, then queues one labelled attachment follow-up, then clears", async () => {
  const calls: string[] = [];
  const input = respondInput(calls);
  await respondToPendingUserInput(input);
  expect(calls).toEqual(["answer", "follow-up", "reset"]);
  expect(input.onRespondToUserInput).toHaveBeenCalledWith(requestId, {
    deploy: "Staging\nbehind the flag",
  });
  expect(input.submitQueuedComposerPrompt).toHaveBeenCalledExactlyOnceWith({
    text: "The attached files are part of my answer to: Deploy target",
    attachments: [{ type: "image", id: "shot" }],
  });
});

it.each(["full", "throws"] as const)(
  "keeps the draft and warns when the follow-up is refused (%s)",
  async (mode) => {
    const calls: string[] = [];
    const input = respondInput(calls, {
      submitQueuedComposerPrompt: vi.fn(async () => {
        if (mode === "throws") throw new Error("offline");
        return "full" as const;
      }),
    });
    await respondToPendingUserInput(input);
    expect(calls).toEqual(["answer"]);
    expect(input.resetComposerDraft).not.toHaveBeenCalled();
    expect(toastManager.add).toHaveBeenLastCalledWith(expect.objectContaining({ type: "error" }));
  },
);

it("sends no follow-up without attachments and nothing at all when the answer is incomplete", async () => {
  const calls: string[] = [];
  await respondToPendingUserInput(respondInput(calls, { images: [] }));
  expect(calls).toEqual(["answer", "reset"]);
  const blank: string[] = [];
  await respondToPendingUserInput(
    respondInput(blank, { activePendingDraftAnswers: {}, promptText: " " }),
  );
  expect(blank).toEqual([]);
});
