import { ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  parseCompactChatPersistedState,
  serializeCompactChatPersistedState,
  shouldAbandonCompactChatThread,
} from "./useCompactChatThread.logic";

const THREAD_ID = ThreadId.makeUnsafe("compact-thread");

const keepDraft = {
  deleting: false,
  presentOnServer: false,
  seenOnServer: false,
  restoring: true,
  persistedMaterialized: false,
  hasLocalDraft: true,
  hydrationFailed: false,
} as const;

describe("compact chat persistence", () => {
  it("parses JSON state and treats a legacy bare id as a materialized thread", () => {
    expect(parseCompactChatPersistedState(null)).toBeNull();
    expect(parseCompactChatPersistedState(THREAD_ID)).toEqual({
      threadId: THREAD_ID,
      materialized: true,
    });
    expect(
      parseCompactChatPersistedState(
        serializeCompactChatPersistedState({ threadId: THREAD_ID, materialized: false }),
      ),
    ).toEqual({ threadId: THREAD_ID, materialized: false });
  });
});

describe("shouldAbandonCompactChatThread", () => {
  it("keeps an unsent local draft that was never on the server", () => {
    expect(shouldAbandonCompactChatThread(keepDraft)).toBe(false);
  });

  it("abandons a persisted server thread that is gone, deleting, or already seen then removed", () => {
    expect(
      shouldAbandonCompactChatThread({
        ...keepDraft,
        persistedMaterialized: true,
      }),
    ).toBe(true);
    expect(
      shouldAbandonCompactChatThread({
        ...keepDraft,
        deleting: true,
        presentOnServer: true,
        persistedMaterialized: true,
      }),
    ).toBe(true);
    expect(
      shouldAbandonCompactChatThread({
        deleting: false,
        presentOnServer: false,
        seenOnServer: true,
        restoring: false,
        persistedMaterialized: true,
        hasLocalDraft: true,
        hydrationFailed: false,
      }),
    ).toBe(true);
    expect(
      shouldAbandonCompactChatThread({
        deleting: false,
        presentOnServer: false,
        seenOnServer: false,
        restoring: false,
        persistedMaterialized: true,
        hasLocalDraft: false,
        hydrationFailed: true,
      }),
    ).toBe(true);
  });

  it("keeps a live server thread that is not deleting", () => {
    expect(
      shouldAbandonCompactChatThread({
        deleting: false,
        presentOnServer: true,
        seenOnServer: true,
        restoring: false,
        persistedMaterialized: true,
        hasLocalDraft: false,
        hydrationFailed: false,
      }),
    ).toBe(false);
  });
});
