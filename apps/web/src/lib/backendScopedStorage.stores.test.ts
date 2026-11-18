import { ThreadId } from "@bigbud/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSpyStorage,
  IDENTITY_A,
  IDENTITY_B,
  installWindow,
  PREFIX_A,
  PREFIX_B,
  touchedKeys,
  type SpyStorage,
} from "./backendScopedStorage.test.helpers";
import type { BackendStorageIdentity } from "./backendScopedStorage";

const THREAD = ThreadId.makeUnsafe("thread-same-id");
const DRAFTS_KEY = "bigbud:composer-drafts:v1";
const UI_KEY = "bigbud:ui-state:v1";

/** Mimics one renderer window: stores are created at module load, then the bootstrap learns
 * the pinned identity (bound windows only) before the first render. */
async function openComposerWindow(
  storage: SpyStorage,
  search: string,
  identity?: BackendStorageIdentity,
) {
  vi.resetModules();
  installWindow(storage, search);
  const scoped = await import("./backendScopedStorage");
  const composer = await import("../stores/composer/composer.store");
  if (identity) scoped.setBackendStorageIdentity(identity);
  return composer;
}

function draftPrompt(composer: Awaited<ReturnType<typeof openComposerWindow>>) {
  return composer.useComposerDraftStore.getState().draftsByThreadId[THREAD]?.prompt;
}

const persistedTerminal = (labels: Record<string, Record<string, string>>) =>
  JSON.stringify({ state: { terminalLabelOverridesByThreadId: labels }, version: 1 });

afterEach(() => vi.unstubAllGlobals());

describe("backend-scoped stores (batch 1)", () => {
  it("scoped_keys_isolate_colliding_thread_ids", async () => {
    const storage = createSpyStorage();

    const local = await openComposerWindow(storage, "");
    local.useComposerDraftStore.getState().setPrompt(THREAD, "local draft");
    local.flushComposerDraftPersistence();

    const a = await openComposerWindow(storage, "?backend=prof-a", IDENTITY_A);
    expect(draftPrompt(a)).toBeUndefined();
    a.useComposerDraftStore.getState().setPrompt(THREAD, "draft on A");
    a.flushComposerDraftPersistence();

    const b = await openComposerWindow(storage, "?backend=prof-b", IDENTITY_B);
    expect(draftPrompt(b)).toBeUndefined();
    b.useComposerDraftStore.getState().setPrompt(THREAD, "draft on B");
    b.flushComposerDraftPersistence();

    expect(draftPrompt(await openComposerWindow(storage, "?backend=prof-a", IDENTITY_A))).toBe(
      "draft on A",
    );
    expect(draftPrompt(await openComposerWindow(storage, "?backend=prof-b", IDENTITY_B))).toBe(
      "draft on B",
    );
    expect(draftPrompt(await openComposerWindow(storage, ""))).toBe("local draft");
    expect([...storage.entries.keys()].toSorted()).toEqual(
      [DRAFTS_KEY, `${PREFIX_A}${DRAFTS_KEY}`, `${PREFIX_B}${DRAFTS_KEY}`].toSorted(),
    );
  });

  it("a write made before the identity is known never lands on any key", async () => {
    const storage = createSpyStorage({ [DRAFTS_KEY]: "untouched" });
    vi.resetModules();
    installWindow(storage, "?backend=prof-a");
    const scoped = await import("./backendScopedStorage");
    const composer = await import("../stores/composer/composer.store");
    composer.useComposerDraftStore.getState().setPrompt(THREAD, "too early");
    composer.flushComposerDraftPersistence();
    expect(touchedKeys(storage)).toEqual([]);

    scoped.setBackendStorageIdentity(IDENTITY_A);
    composer.flushComposerDraftPersistence();
    expect(storage.entries.get(DRAFTS_KEY)).toBe("untouched");
    expect(touchedKeys(storage).every((key) => key.startsWith(PREFIX_A))).toBe(true);
  });

  it("ui state rehydrates from the backend namespace once the identity arrives", async () => {
    const storage = createSpyStorage({
      [UI_KEY]: JSON.stringify({ lastActiveThreadId: "local-thread" }),
      [`${PREFIX_A}${UI_KEY}`]: JSON.stringify({ lastActiveThreadId: "remote-thread" }),
    });
    vi.resetModules();
    installWindow(storage, "?backend=prof-a");
    const scoped = await import("./backendScopedStorage");
    const { useUiStateStore } = await import("../stores/ui/ui.store");
    expect(useUiStateStore.getState().lastActiveThreadId).toBeNull();

    scoped.setBackendStorageIdentity(IDENTITY_A);
    expect(useUiStateStore.getState().lastActiveThreadId).toBe("remote-thread");
    expect(touchedKeys(storage).every((key) => key.startsWith(PREFIX_A))).toBe(true);
  });

  it("terminal state rehydrates per backend and never reads the local key", async () => {
    const terminalKey = "bigbud:terminal-state:v1";
    const storage = createSpyStorage({
      [terminalKey]: persistedTerminal({ [THREAD]: { t1: "local" } }),
      [`${PREFIX_B}${terminalKey}`]: persistedTerminal({ [THREAD]: { t1: "remote" } }),
    });
    vi.resetModules();
    installWindow(storage, "?backend=prof-b");
    const scoped = await import("./backendScopedStorage");
    const { useTerminalStateStore } = await import("../stores/terminal/terminal.store");
    scoped.setBackendStorageIdentity(IDENTITY_B);
    expect(useTerminalStateStore.getState().terminalLabelOverridesByThreadId[THREAD]).toEqual({
      t1: "remote",
    });
    expect(touchedKeys(storage).every((key) => key.startsWith(PREFIX_B))).toBe(true);
  });

  it("ledger locks, channels and storage are namespaced per backend", async () => {
    const storage = createSpyStorage();
    vi.resetModules();
    installWindow(storage, "?backend=prof-a");
    const scoped = await import("./backendScopedStorage");
    const ledger = await import("../stores/ledger/revisionedLedger");
    expect(ledger.resolveLedgerStorage()).toBeNull();

    scoped.setBackendStorageIdentity(IDENTITY_A);
    const lockNames: string[] = [];
    const lockManager = {
      request: <T>(name: string, run: () => Promise<T>) => {
        lockNames.push(name);
        return run();
      },
    };
    await ledger.mutateRevisionedLedger({
      key: "bigbud:test-ledger",
      channelName: "bigbud:test-ledger",
      lockManager,
      read: (s) => {
        const raw = s?.getItem("bigbud:test-ledger");
        return {
          status: "ready" as const,
          value: raw ? JSON.parse(raw) : { revision: 0, lastMutationId: "" },
        };
      },
      mutate: (current, mutationId) => ({
        ledger: { revision: current.revision + 1, lastMutationId: mutationId },
        result: null,
      }),
    });
    expect(lockNames[0]).toBe(`bigbud:${PREFIX_A}bigbud:test-ledger:write`);
    expect([...storage.entries.keys()]).toEqual([`${PREFIX_A}bigbud:test-ledger`]);
  });
});
