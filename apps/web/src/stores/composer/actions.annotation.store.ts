import { type ThreadId } from "@bigbud/contracts";
import type { StoreApi } from "zustand";
import { createEmptyThreadDraft, shouldRemoveDraft } from "./normalization.store";
import {
  type ComposerAnnotationAttachment,
  type ComposerDraftStoreState,
  type ComposerThreadDraftState,
} from "./types.store";

type SetFn = StoreApi<ComposerDraftStoreState>["setState"];

export function createComposerAnnotationActions(set: SetFn) {
  return {
    addAnnotation: (threadId: ThreadId, annotation: ComposerAnnotationAttachment) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        if (
          existing.annotations.some(
            (entry) => entry.id === annotation.id || entry.imageId === annotation.imageId,
          )
        ) {
          return state;
        }
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: {
              ...existing,
              annotations: [...existing.annotations, annotation],
            },
          },
        };
      });
    },
    addAnnotations: (threadId: ThreadId, annotations: ComposerAnnotationAttachment[]) => {
      if (threadId.length === 0 || annotations.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const existingIds = new Set(existing.annotations.map((annotation) => annotation.id));
        const existingImageIds = new Set(
          existing.annotations.map((annotation) => annotation.imageId),
        );
        const accepted: ComposerAnnotationAttachment[] = [];
        for (const annotation of annotations) {
          if (existingIds.has(annotation.id) || existingImageIds.has(annotation.imageId)) {
            continue;
          }
          existingIds.add(annotation.id);
          existingImageIds.add(annotation.imageId);
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
