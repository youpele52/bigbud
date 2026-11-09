import { expect, it } from "vitest";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { claimComposerSend, type PendingComposerSend } from "./ChatView.sendTurn.pending";
import type { UseOnSendInput } from "./ChatView.sendTurn.types";

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
