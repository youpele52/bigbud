import { type ThreadId } from "@bigbud/contracts";
import type { StoreApi } from "zustand";
import { createEmptyThreadDraft, shouldRemoveDraft } from "./normalization.store";
import {
  type ComposerAnnotationAttachment,
  type ComposerDraftStoreState,
  type ComposerThreadDraftState,
} from "./types.store";
import {
  isCodeAnnotationAttachment,
  normalizeAnnotationAttachment,
} from "./types.annotation.store";

type SetFn = StoreApi<ComposerDraftStoreState>["setState"];

export function createComposerAnnotationActions(set: SetFn) {
  const dedupKey = (annotation: ComposerAnnotationAttachment) =>
    isCodeAnnotationAttachment(annotation) ? annotation.id : annotation.imageId;

  return {
    addAnnotation: (threadId: ThreadId, annotation: ComposerAnnotationAttachment) => {
      if (threadId.length === 0) {
        return;
      }
      const normalizedAnnotation = normalizeAnnotationAttachment(annotation);
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        if (
          existing.annotations.some(
            (entry) =>
              entry.id === normalizedAnnotation.id ||
              dedupKey(entry) === dedupKey(normalizedAnnotation),
          )
        ) {
          return state;
        }
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: {
              ...existing,
              annotations: [...existing.annotations, normalizedAnnotation],
            },
          },
        };
      });
    },
    addAnnotations: (threadId: ThreadId, annotations: ComposerAnnotationAttachment[]) => {
      if (threadId.length === 0 || annotations.length === 0) {
        return;
      }
      const normalizedAnnotations = annotations.map((annotation) =>
        normalizeAnnotationAttachment(annotation),
      );
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const existingIds = new Set(existing.annotations.map((annotation) => annotation.id));
        const existingDedupKeys = new Set(
          existing.annotations.map((annotation) => dedupKey(annotation)),
        );
        const accepted: ComposerAnnotationAttachment[] = [];
        for (const annotation of normalizedAnnotations) {
          const key = dedupKey(annotation);
          if (existingIds.has(annotation.id) || existingDedupKeys.has(key)) {
            continue;
          }
          existingIds.add(annotation.id);
          existingDedupKeys.add(key);
          accepted.push(annotation);
        }
        if (accepted.length === 0) {
          return state;
        }
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: {
              ...existing,
              annotations: [...existing.annotations, ...accepted],
            },
          },
        };
      });
    },
    removeAnnotation: (threadId: ThreadId, annotationId: string) => {
      if (threadId.length === 0 || annotationId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          annotations: current.annotations.filter((annotation) => annotation.id !== annotationId),
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
  };
}
