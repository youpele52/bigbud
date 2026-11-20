import type { UseOnSendInput } from "./ChatView.sendTurn.types";

const unchanged = <T>(current: T[], sent: T[]) =>
  current.length === sent.length && current.every((value, index) => value === sent[index]);

export function captureComposerContent(input: UseOnSendInput) {
  return {
    prompt: input.promptRef.current,
    images: input.composerImages,
    files: input.composerFiles,
    annotations: input.composerAnnotations,
    terminalContexts: input.composerTerminalContexts,
  };
}

export function matchesComposerContent(
  input: UseOnSendInput,
  sent: ReturnType<typeof captureComposerContent>,
): boolean {
  return (
    input.promptRef.current === sent.prompt &&
    unchanged(input.composerImagesRef.current, sent.images) &&
    unchanged(input.composerFilesRef.current, sent.files) &&
    unchanged(input.composerAnnotationsRef.current, sent.annotations) &&
    unchanged(input.composerTerminalContextsRef.current, sent.terminalContexts)
  );
}

export interface PendingComposerSend {
  threadId: string;
  queued: boolean;
  consumed: boolean;
  content: ReturnType<typeof captureComposerContent>;
}

/** Exclude overlapping direct sends, but allow distinct queued drafts to prepare independently. */
export function claimComposerSend(
  pending: Set<PendingComposerSend>,
  input: UseOnSendInput,
  queued: boolean,
) {
  const threadId = input.activeThread!.id;
  for (const entry of pending) {
    if (entry.threadId !== threadId) continue;
    if (
      (!queued && !entry.queued) ||
      (!entry.consumed && matchesComposerContent(input, entry.content))
    ) {
      return null;
    }
  }
  const entry: PendingComposerSend = {
    threadId,
    queued,
    consumed: false,
    content: captureComposerContent(input),
  };
  pending.add(entry);
  return {
    content: entry.content,
    consume: () => {
      entry.consumed = true;
    },
    release: () => {
      pending.delete(entry);
    },
  };
}
