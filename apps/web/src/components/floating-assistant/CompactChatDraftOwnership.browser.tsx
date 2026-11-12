import { ProjectId, ThreadId } from "@bigbud/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useState } from "react";

import { useThreadSurfaceLifetime } from "~/components/chat/view/ChatView.threadLifetime";
import { useComposerDraftStore } from "~/stores/composer";
import { resetComposerDraftStore } from "~/stores/composer/composer.store.test.utils";
import { useStore } from "~/stores/main";
import { makeThread } from "~/stores/main/main.store.test.helpers";
import { readOwnershipLedger } from "~/stores/ownership/ownershipLedger";
import { OWNERSHIP_LEDGER_KEY } from "~/stores/ownership/ownershipLedger.storage";
import { useCompactChatDraftOwnership } from "~/hooks/useCompactChatDraftOwnership";

const threadId = ThreadId.makeUnsafe("fresh-compact");
const projectId = ProjectId.makeUnsafe("compact-project");
function Harness({ enabled = true }: { enabled?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const retry = useCompactChatDraftOwnership({
    enabled,
    threadId,
    projectId,
    initialSelection: null,
    captureSurface: useThreadSurfaceLifetime(threadId),
    setThreadSyncError: setError,
  });
  return (
    <>
      <span>{error}</span>
      <button onClick={retry}>Retry</button>
    </>
  );
}

beforeEach(() => {
  localStorage.clear();
  resetComposerDraftStore();
  useStore.setState(useStore.getInitialState());
});
afterEach(() => vi.restoreAllMocks());

it("publishes durable compact ownership without erasing unsent content", async () => {
  useComposerDraftStore.getState().setPrompt(threadId, "keep this prompt");
  const mounted = await render(<Harness />);
  try {
    await vi.waitFor(() =>
      expect(useComposerDraftStore.getState().getDraftThread(threadId)).not.toBeNull(),
    );
    const ledger = readOwnershipLedger();
    expect(ledger.status).toBe("ready");
    if (ledger.status !== "ready") return;
    expect(ledger.value.scopes.compact.projectBindingsByProjectId[projectId]?.threadId).toBe(
      threadId,
    );
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
      "keep this prompt",
    );
  } finally {
    await mounted.unmount();
  }
});

it.each(["unmount", "canonical"] as const)(
  "does not publish a queued draft after %s",
  async (settlement) => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holding = navigator.locks.request(`bigbud:${OWNERSHIP_LEDGER_KEY}:write`, async () => {
      entered();
      await gate;
    });
    await locked;
    const mounted = await render(<Harness />);
    if (settlement === "unmount") await mounted.unmount();
    else useStore.setState({ threads: [makeThread({ id: threadId, projectId })] });
    release();
    await holding;
    // Drain the same lock queue after the abandoned initialization.
    await navigator.locks.request(`bigbud:${OWNERSHIP_LEDGER_KEY}:write`, async () => undefined);
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    const ledger = readOwnershipLedger();
    if (ledger.status !== "ready") throw new Error("Ledger must remain readable");
    expect(ledger.value.scopes.compact.draftsByThreadId[threadId]).toBeUndefined();
    if (settlement === "canonical") {
      expect(document.body.textContent).not.toContain("superseded");
      await mounted.unmount();
    }
  },
);

it("reports storage failure and retries the same identity", async () => {
  const original = Storage.prototype.setItem;
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, key, value) {
      if (key === OWNERSHIP_LEDGER_KEY) throw new Error("Storage refused");
      original.call(this, key, value);
    });
  const mounted = await render(<Harness />);
  try {
    await expect.element(mounted.getByText(/Ownership ledger|Ledger unavailable/)).toBeVisible();
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    write.mockRestore();
    await mounted.getByRole("button", { name: "Retry" }).click();
    await vi.waitFor(() =>
      expect(useComposerDraftStore.getState().getDraftThread(threadId)).not.toBeNull(),
    );
    expect(Object.keys(useComposerDraftStore.getState().draftThreadsByThreadId)).toEqual([
      threadId,
    ]);
  } finally {
    await mounted.unmount();
  }
});

it("does not overwrite draft metadata changed while registration waits", async () => {
  const key = `bigbud:${OWNERSHIP_LEDGER_KEY}:write`;
  let releaseInitialization!: () => void;
  let releaseRegistration!: () => void;
  let entered!: () => void;
  const initialization = new Promise<void>((resolve) => {
    releaseInitialization = resolve;
  });
  const registration = new Promise<void>((resolve) => {
    releaseRegistration = resolve;
  });
  const enteredRegistration = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const initialLock = navigator.locks.request(key, async () => {
    await initialization;
  });
  useComposerDraftStore.getState().setDraftThreadContext(threadId, {
    projectId,
    branch: null,
    worktreePath: null,
    envMode: "local",
    interactionMode: "default",
    runtimeMode: "approval-required",
  });
  const mounted = await render(<Harness />);
  const registrationLock = navigator.locks.request(key, async () => {
    entered();
    await registration;
  });
  releaseInitialization();
  await initialLock;
  await enteredRegistration;
  try {
    await vi.waitFor(async () =>
      expect((await navigator.locks.query()).pending?.some((lock) => lock.name === key)).toBe(true),
    );
    useComposerDraftStore.getState().setDraftThreadContext(threadId, {
      projectId,
      branch: "new-branch",
      worktreePath: "/new-worktree",
      envMode: "worktree",
      interactionMode: "default",
      runtimeMode: "approval-required",
    });
    releaseRegistration();
    await registrationLock;
    await expect.element(mounted.getByText(/draft changed while/)).toBeVisible();
    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.worktreePath).toBe(
      "/new-worktree",
    );
    await mounted.getByRole("button", { name: "Retry" }).click();
    await vi.waitFor(() => {
      const ledger = readOwnershipLedger();
      expect(
        ledger.status === "ready" &&
          ledger.value.scopes.compact.draftsByThreadId[threadId]?.worktreePath,
      ).toBe("/new-worktree");
    });
  } finally {
    releaseRegistration();
    await registrationLock;
    await mounted.unmount();
  }
});
