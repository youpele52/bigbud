import { afterEach, describe, expect, it, vi } from "vitest";

import {
  changeFileEditDraft,
  fileEditKey,
  getFileEditDraft,
  observeFileEditRead,
} from "./fileEditDrafts";
import {
  flushRemoteFileEditDrafts,
  NOT_KEPT_MESSAGE,
  REMOTE_DRAFT_RETENTION_MS,
  REMOTE_DRAFT_STORAGE_KEY,
  resetRemoteFileEditDraftMirror,
  restoreRemoteFileEditDrafts,
} from "./fileEditDrafts.persist";
import { fileEditEntries } from "./fileEditDrafts.state";

const store = vi.hoisted(() => new Map<string, string>());
vi.mock("../../lib/backendScopedStorage", () => ({
  backendScopedLocalStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  },
  onBackendStorageReady: () => () => {},
}));
const write = vi.hoisted(() => vi.fn());
vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => ({ projects: { writeFile: write } }),
}));

const baseHash = "a".repeat(64);
const remoteTarget = "ssh:host=dev&transport=agent";

function open(executionTargetId?: string) {
  const cwd = `/workspace/${crypto.randomUUID()}`;
  const relativePath = "file.txt";
  observeFileEditRead({
    cwd,
    relativePath,
    contents: "old",
    sha256: baseHash,
    ...(executionTargetId ? { executionTargetId } : {}),
  });
  return { cwd, relativePath, key: fileEditKey(cwd, relativePath, executionTargetId) };
}

const stored = () =>
  JSON.parse(store.get(REMOTE_DRAFT_STORAGE_KEY) ?? "[]") as Array<{ key: string }>;

afterEach(() => {
  resetRemoteFileEditDraftMirror();
  store.clear();
  fileEditEntries.clear();
  write.mockReset();
  vi.useRealTimers();
});

describe("remote draft persistence", () => {
  it("stores an unacknowledged remote draft and restores it as unsaveable until re-read", () => {
    write.mockReturnValue(new Promise(() => {}));
    const input = open(remoteTarget);
    changeFileEditDraft(input.key, "draft");
    flushRemoteFileEditDrafts();
    expect(stored().map((record) => record.key)).toEqual([input.key]);
    fileEditEntries.clear();
    resetRemoteFileEditDraftMirror();
    restoreRemoteFileEditDrafts();
    expect(getFileEditDraft(input.key)).toMatchObject({
      contents: "draft",
      status: "error",
      retryAllowed: false,
      needsVerification: true,
      remote: true,
    });
  });

  it("never stores local drafts", () => {
    const input = open();
    changeFileEditDraft(input.key, "draft");
    flushRemoteFileEditDrafts();
    expect(store.has(REMOTE_DRAFT_STORAGE_KEY)).toBe(false);
  });

  it("drops the stored copy once the host acknowledges the save", async () => {
    write.mockResolvedValue({ relativePath: "file.txt" });
    const input = open(remoteTarget);
    changeFileEditDraft(input.key, "draft");
    flushRemoteFileEditDrafts();
    expect(stored()).toHaveLength(1);
    await vi.waitFor(() => expect(getFileEditDraft(input.key)?.status).toBe("saved"), {
      timeout: 5000,
    });
    flushRemoteFileEditDrafts();
    expect(store.has(REMOTE_DRAFT_STORAGE_KEY)).toBe(false);
  });

  it("does not restore drafts older than the retention window", () => {
    write.mockReturnValue(new Promise(() => {}));
    const input = open(remoteTarget);
    changeFileEditDraft(input.key, "draft");
    flushRemoteFileEditDrafts();
    fileEditEntries.clear();
    resetRemoteFileEditDraftMirror();
    restoreRemoteFileEditDrafts(Date.now() + REMOTE_DRAFT_RETENTION_MS + 1);
    expect(getFileEditDraft(input.key)).toBeNull();
    // Expired remote contents are removed from storage, not just ignored.
    expect(store.has(REMOTE_DRAFT_STORAGE_KEY)).toBe(false);
  });

  it("removes the stored copy and warns when a draft grows over the budget", () => {
    write.mockReturnValue(new Promise(() => {}));
    const input = open(remoteTarget);
    changeFileEditDraft(input.key, "draft");
    flushRemoteFileEditDrafts();
    expect(stored()).toHaveLength(1);
    changeFileEditDraft(input.key, "x".repeat(600 * 1024));
    flushRemoteFileEditDrafts();
    expect(store.has(REMOTE_DRAFT_STORAGE_KEY)).toBe(false);
  });

  it("keeps other drafts when storage is full, warning about the one it drops", () => {
    write.mockReturnValue(new Promise(() => {}));
    const first = open(remoteTarget);
    changeFileEditDraft(first.key, "first draft");
    flushRemoteFileEditDrafts();
    const second = open(remoteTarget);
    changeFileEditDraft(second.key, "second draft");
    const setItem = store.set.bind(store);
    let failures = 1;
    store.set = (key: string, value: string) => {
      if (failures-- > 0) throw new Error("QuotaExceededError");
      return setItem(key, value);
    };
    try {
      flushRemoteFileEditDrafts();
    } finally {
      store.set = setItem;
    }
    expect(stored().map((record) => record.key)).toEqual([second.key]);
    expect(getFileEditDraft(first.key)?.message).toBe(NOT_KEPT_MESSAGE);
  });
});
