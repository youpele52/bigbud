import { CommandId, ThreadId } from "@bigbud/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { forgetMobileHostConnection } from "./MobileSessionRuntime.forget";
import { createMobileComposerDraft, writeMobileComposerDraft } from "../lib/mobileComposerDraft";
import {
  makeMobileComposerDraftIdentity,
  mobileComposerDraftKey,
} from "../lib/mobileComposerDraft.identity";
import { writeMobileSession, type StoredMobileSession } from "../lib/mobileSession";

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}
let drafts: ReturnType<typeof storage>;
let local: ReturnType<typeof storage>;
let count = 0;
let session: StoredMobileSession;
beforeEach(() => {
  drafts = storage();
  local = storage();
  vi.stubGlobal("sessionStorage", drafts);
  vi.stubGlobal("window", { localStorage: local });
  session = {
    backendBaseUrl: "https://legacy.example",
    sessionId: `session-${++count}`,
    sessionToken: "fixture-token",
    scope: "thread-control",
    expiresAt: "2099-01-01T00:00:00Z",
    websocketUrl: "wss://legacy.example/mobile-ws?token=fixture-token",
  };
  writeMobileSession(session);
});
afterEach(() => vi.unstubAllGlobals());
function saveUncertain(backendBaseUrl = session.backendBaseUrl) {
  const identity = makeMobileComposerDraftIdentity({
    ...session,
    backendBaseUrl,
    threadId: "same-thread",
  });
  const draft = createMobileComposerDraft({
    threadId: ThreadId.makeUnsafe("same-thread"),
    prompt: "private draft",
  });
  expect(
    writeMobileComposerDraft(identity, {
      ...draft,
      submitted: {
        command: {
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("original-command"),
          threadId: draft.threadId,
          createdAt: draft.updatedAt,
        },
        submittedRevision: 0,
        submittedAt: draft.updatedAt,
        deadlineAt: 1,
        status: "uncertain",
      },
    }).ok,
  ).toBe(true);
  return mobileComposerDraftKey(identity);
}
function request(forgetLegacy = vi.fn(() => true)) {
  return {
    selected: null,
    legacyStored: session,
    forgetHost: vi.fn(() => true),
    forgetLegacy,
    onPersisted: vi.fn(),
    onLegacyCleared: vi.fn(),
    reportIssue: vi.fn(),
  };
}
it("explicit legacy Forget removes its draft and uncertain ID while preserving another host", () => {
  const own = saveUncertain();
  const other = saveUncertain("https://other.example");
  const input = request();
  expect(forgetMobileHostConnection(input)).toBe(true);
  expect(drafts.getItem(own)).toBeNull();
  expect(drafts.getItem(other)).toContain("original-command");
  expect(local.values.size).toBe(0);
  expect(input.onPersisted).toHaveBeenCalledOnce();
  expect(input.onLegacyCleared).toHaveBeenCalledOnce();
  expect(input.reportIssue).not.toHaveBeenCalled();
});
it("still removes explicit legacy drafts when credential removal fails after collection commit", () => {
  const own = saveUncertain();
  const input = request();
  local.removeItem = () => {
    throw new Error("storage unavailable");
  };
  expect(forgetMobileHostConnection(input)).toBe(false);
  expect(drafts.getItem(own)).toBeNull();
  expect(local.values.size).toBe(1);
  expect(input.onPersisted).toHaveBeenCalledOnce();
  expect(input.onLegacyCleared).not.toHaveBeenCalled();
  expect(input.reportIssue).toHaveBeenCalledWith(expect.stringContaining("previous credential"));
});
it("failed atomic envelope removal preserves credential, draft and original command ID", () => {
  const own = saveUncertain();
  const raw = drafts.getItem(own);
  const input = request(vi.fn(() => false));
  expect(forgetMobileHostConnection(input)).toBe(false);
  expect(drafts.getItem(own)).toBe(raw);
  expect(local.values.size).toBe(1);
  expect(input.onPersisted).not.toHaveBeenCalled();
  expect(input.onLegacyCleared).not.toHaveBeenCalled();
});
