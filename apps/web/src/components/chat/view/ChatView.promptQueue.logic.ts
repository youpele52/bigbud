import type { ThreadId } from "@bigbud/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ComposerTrigger } from "../../../logic/composer";

export const MAX_QUEUED_PROMPTS = 5;

export interface QueuedPrompt {
  id: string;
  text: string;
  createdAt: string;
}

export type QueuePromptResult = "queued" | "empty" | "full";

export function formatQueuedPromptText(prompts: readonly QueuedPrompt[]) {
  const numberedPrompts = prompts
    .map((prompt, index) => `${index + 1}. ${prompt.text.trim()}`)
    .join("\n\n");

  return ["Additional instructions:", "", numberedPrompts].join("\n");
}

interface UsePromptQueueInput {
  threadId: ThreadId;
  promptRef: React.MutableRefObject<string>;
  activeTurnInProgress: boolean;
  canAutoFlush: boolean;
  setPrompt: (prompt: string) => void;
  setComposerShellMode: (shellMode: boolean) => void;
  setComposerCursor: React.Dispatch<React.SetStateAction<number>>;
  setComposerTrigger: React.Dispatch<React.SetStateAction<ComposerTrigger | null>>;
  collapseExpandedComposerCursor: (value: string, expandedCursor: number) => number;
  detectComposerTrigger: (value: string, expandedCursor: number) => ComposerTrigger | null;
  onSend: () => Promise<void>;
  onInterrupt: () => Promise<void>;
  setForceSendQueuedPrompt: (force: boolean) => void;
  scheduleComposerFocus: () => void;
  newId: () => string;
}

export function usePromptQueue(input: UsePromptQueueInput) {
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const [flushAfterInterrupt, setFlushAfterInterrupt] = useState(false);
  const queuedPromptsRef = useRef<QueuedPrompt[]>([]);
  const isFlushingRef = useRef(false);

  useEffect(() => {
    queuedPromptsRef.current = [];
    setQueuedPrompts([]);
    setFlushAfterInterrupt(false);
    isFlushingRef.current = false;
  }, [input.threadId]);

  const queuedPromptCount = queuedPrompts.length;
  const hasQueuedPrompts = queuedPromptCount > 0;
  const canQueueMorePrompts = queuedPromptCount < MAX_QUEUED_PROMPTS;

  const queuePrompt = useCallback(
    (text: string): QueuePromptResult => {
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        return "empty";
      }

      const existing = queuedPromptsRef.current;
      if (existing.length >= MAX_QUEUED_PROMPTS) {
        return "full";
      }
      const next = [
        ...existing,
        {
          id: input.newId(),
          text: trimmed,
          createdAt: new Date().toISOString(),
        },
      ];
      queuedPromptsRef.current = next;
      setQueuedPrompts(next);
      return "queued";
    },
    [input],
  );

  const removeQueuedPrompt = useCallback((id: string) => {
    const next = queuedPromptsRef.current.filter((prompt) => prompt.id !== id);
    queuedPromptsRef.current = next;
    setQueuedPrompts(next);
  }, []);

  const clearQueuedPrompts = useCallback(() => {
    queuedPromptsRef.current = [];
    setQueuedPrompts([]);
    setFlushAfterInterrupt(false);
  }, []);

  const flushQueuedPrompts = useCallback(async () => {
    if (isFlushingRef.current || queuedPrompts.length === 0) {
      return;
    }
    isFlushingRef.current = true;
    const nextPrompt = formatQueuedPromptText(queuedPrompts);
    queuedPromptsRef.current = [];
    setQueuedPrompts([]);
    setFlushAfterInterrupt(false);
    input.promptRef.current = nextPrompt;
    input.setPrompt(nextPrompt);
    input.setComposerShellMode(false);
    input.setComposerCursor(input.collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
    input.setComposerTrigger(input.detectComposerTrigger(nextPrompt, nextPrompt.length));
    input.scheduleComposerFocus();
    input.setForceSendQueuedPrompt(true);
    window.requestAnimationFrame(() => {
      void input.onSend().finally(() => {
        input.setForceSendQueuedPrompt(false);
        isFlushingRef.current = false;
      });
    });
  }, [input, queuedPrompts]);

  const interruptAndFlushQueuedPrompts = useCallback(async () => {
    if (queuedPrompts.length === 0) {
      return;
    }
    setFlushAfterInterrupt(true);
    if (input.activeTurnInProgress) {
      try {
        await input.onInterrupt();
      } catch (err) {
        setFlushAfterInterrupt(false);
        throw err;
      }
      return;
    }
    await flushQueuedPrompts();
  }, [flushQueuedPrompts, input, queuedPrompts.length]);

  useEffect(() => {
    if (!hasQueuedPrompts || input.activeTurnInProgress || !input.canAutoFlush) {
      return;
    }
    if (flushAfterInterrupt || !isFlushingRef.current) {
      void flushQueuedPrompts();
    }
  }, [
    flushAfterInterrupt,
    flushQueuedPrompts,
    hasQueuedPrompts,
    input.activeTurnInProgress,
    input.canAutoFlush,
  ]);

  return useMemo(
    () => ({
      queuedPrompts,
      queuedPromptCount,
      hasQueuedPrompts,
      canQueueMorePrompts,
      queuePrompt,
      removeQueuedPrompt,
      clearQueuedPrompts,
      interruptAndFlushQueuedPrompts,
    }),
    [
      canQueueMorePrompts,
      clearQueuedPrompts,
      hasQueuedPrompts,
      interruptAndFlushQueuedPrompts,
      queuePrompt,
      queuedPromptCount,
      queuedPrompts,
      removeQueuedPrompt,
    ],
  );
}
