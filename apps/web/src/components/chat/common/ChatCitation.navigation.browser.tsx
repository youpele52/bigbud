import "../../../index.css";
import type { GetSelectedThreadDetailResult } from "@bigbud/contracts/orchestration/orchestration.detail.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useStore } from "../../../stores/main/main.store";
import { makeThread } from "../../../stores/main/main.store.test.helpers";
import { useComposerDraftStore } from "../../../stores/composer/composer.store";
import { useSearchStore } from "../../../stores/ui/search.store";
import { useChatViewContentHandlers } from "../view/chat-view/ChatViewContent.handlers";
import type { ChatViewBaseState } from "../view/chat-view/chat-view-base-state.hooks";
import type { ChatViewRuntimeState } from "../view/chat-view/chat-view-runtime.hooks";
import type { ChatViewThreadDerivedState } from "../view/chat-view/chat-view-thread-derived.hooks";
import {
  CITE_MESSAGES,
  CITE_THREAD_ID,
  CitationBrowserHarness,
  seedCitation,
} from "./ChatCitation.browser.helpers";

const mocks = vi.hoisted(() => ({ getDetail: vi.fn() }));
vi.mock("../../../rpc/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../rpc/nativeApi")>()),
  readNativeApi: () => ({ orchestration: { getSelectedThreadDetail: mocks.getDetail } }),
}));
vi.mock("../../../rpc/serverState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../rpc/serverState")>()),
  useServerDiscoveredAgents: () => [],
  useServerDiscoveredSkills: () => [],
}));

const runtime = {
  scrollBehavior: { scrollToMessage: () => false },
} as unknown as ChatViewRuntimeState;
function HydrationHarness() {
  const activeThread = useStore((state) =>
    state.threads.find((thread) => thread.id === CITE_THREAD_ID),
  );
  const handlers = useChatViewContentHandlers({
    base: { activeThread } as ChatViewBaseState,
    runtime,
    thread: {} as ChatViewThreadDerivedState,
  });
  return (
    <CitationBrowserHarness
      messages={activeThread?.messages ?? []}
      focusMessageId={handlers.focusMessageId}
    />
  );
}

function sourceDetail(): GetSelectedThreadDetailResult {
  const thread = makeThread({ id: CITE_THREAD_ID });
  const source = CITE_MESSAGES[1]!;
  return {
    projectionSequence: 1,
    threadId: thread.id,
    projectId: thread.projectId,
    activityTurnId: null,
    messages: [
      {
        ...source,
        turnId: null,
        updatedAt: source.createdAt,
        attachments: [],
        attachmentsTruncated: false,
      },
    ],
    messageWindow: {
      order: "newest-first",
      requestedCursor: null,
      newestCursor: null,
      oldestCursor: null,
      nextCursor: null,
      hasOlder: true,
    },
    activities: [],
    activitiesTruncated: false,
    pendingApprovals: [],
    pendingApprovalsTruncated: false,
    pendingUserInputs: [],
    pendingUserInputsTruncated: false,
    activePlan: null,
    activeTasks: [],
    activeTasksTruncated: false,
    checkpoints: [],
    checkpointsTruncated: false,
  };
}

beforeEach(() => {
  mocks.getDetail.mockReset();
  useStore.setState({
    threads: [makeThread({ id: CITE_THREAD_ID, messages: [CITE_MESSAGES[0]!] })],
  });
  useComposerDraftStore.setState({ draftsByThreadId: {} });
  useSearchStore.setState({ focusRequest: null });
  seedCitation();
});
afterEach(() => {
  CSS.highlights?.clear();
});

it("loads an older citation source through the bounded message-anchor query before focusing it", async () => {
  mocks.getDetail.mockResolvedValue(sourceDetail());
  const screen = await render(<HydrationHarness />);
  expect(document.querySelector('[data-message-id="cite-assistant"]')).toBeNull();
  await page.getByRole("button", { name: "Go to citation from AI: quoted phrase" }).click();
  expect(mocks.getDetail).toHaveBeenCalledExactlyOnceWith({
    threadId: CITE_THREAD_ID,
    messageAnchorId: "cite-assistant",
    messageLimit: 20,
  });
  await expect.poll(() => CSS.highlights.get("bigbud-chat-citation")?.size).toBe(1);
  expect(([...CSS.highlights.get("bigbud-chat-citation")!][0] as Range).toString()).toBe(
    "quoted phrase",
  );
  expect(useSearchStore.getState().focusRequest).toBeNull();
  await screen.unmount();
});

it("retains the quote and clears the navigation request when its source is unavailable", async () => {
  mocks.getDetail.mockResolvedValue({ ...sourceDetail(), messages: [] });
  const screen = await render(<HydrationHarness />);
  await page.getByRole("button", { name: "Go to citation from AI: quoted phrase" }).click();
  await expect.poll(() => useSearchStore.getState().focusRequest).toBeNull();
  expect(
    useComposerDraftStore.getState().draftsByThreadId[CITE_THREAD_ID]?.annotations[0],
  ).toMatchObject({
    selection: { text: "quoted phrase" },
  });
  expect(CSS.highlights.get("bigbud-chat-citation")).toBeUndefined();
  await expect
    .element(page.getByRole("button", { name: "Go to citation from AI: quoted phrase" }))
    .toBeVisible();
  await screen.unmount();
});
