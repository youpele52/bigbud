import "../../../../index.css";

import type { ComponentProps } from "react";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useThreadNoticeDismissalStore } from "../../../../stores/ui/threadNoticeDismissal.store";
import { ChatViewChatBody } from "./ChatViewChatBody";

const state = vi.hoisted(() => ({
  retained: null as string | null,
  setupError: null as string | null,
  revision: "one",
}));
vi.mock("~/hooks/useThreadActions", () => ({ useThreadActions: () => ({}) }));
vi.mock("./ChatViewContent.handlers", () => ({ useChatViewContentHandlers: () => ({}) }));
vi.mock("~/components/git/BranchToolbar", () => ({ default: () => null }));
vi.mock("../../common/ContextWindowWarningBanner", () => ({
  ContextWindowWarningBanner: () => null,
}));
vi.mock("../../provider/ProviderStatusBanner", () => ({ ProviderStatusBanner: () => null }));
vi.mock("../../common/ThreadErrorBanner", () => ({ ThreadErrorBanner: () => null }));
vi.mock("../../common/AccessModeInfoBanner", () => ({ AccessModeInfoBanner: () => null }));
vi.mock("../../messages/MessagesTimeline", () => ({ MessagesTimeline: () => "transcript" }));
vi.mock("../../agents/DelegatedChildrenCard", () => ({ DelegatedChildrenCard: () => null }));
vi.mock("../../agents/ChatAgentActivityFeed", () => ({ ChatAgentActivityFeed: () => null }));
vi.mock("../../scroller/ThreadReaderOutline", () => ({ ThreadReaderOutline: () => null }));
vi.mock("./ChatViewMainComposer", () => ({ ChatViewMainComposer: () => "composer-controls" }));
vi.mock("../ThreadRecoveryNotices", () => ({ ThreadRecoveryNotices: () => null }));
vi.mock("./useOpencodeV2RetainedHistory", () => ({
  useOpencodeV2RetainedHistory: () => state.retained,
}));
vi.mock("../../provider/useOpenCodeRuntimeSetup", () => ({
  useOpenCodeRuntimeSetup: () => ({
    verified: false,
    error: state.setupError,
    severity: "warning",
    noticeIdentity: state.revision,
  }),
}));

function makeProps(id = "thread-one") {
  return {
    base: {
      threadId: id,
      activeThread: {
        id,
        modelSelection: { provider: "opencodeV2" },
        error: "source error remains",
        activities: [],
      },
      isServerThread: true,
      settings: { providers: { opencodeV2: {} } },
    },
    composer: {},
    interactions: {},
    runtime: { scrollBehavior: { readerPosition: {} } },
    thread: {},
    timeline: {},
    onOpenOrchestra: vi.fn(),
  } as unknown as ComponentProps<typeof ChatViewChatBody>;
}

afterEach(() => {
  document.body.innerHTML = "";
  state.retained = null;
  state.setupError = null;
  state.revision = "one";
  useThreadNoticeDismissalStore.setState({ dismissed: new Set() });
});

it("hides retained-history presentation without restoring the composer or clearing source errors", async () => {
  state.retained = "This transcript is retained read-only history.";
  const props = makeProps();
  await render(<ChatViewChatBody {...props} />);
  await expect.element(page.getByText(state.retained)).toBeVisible();
  await page.getByRole("button", { name: "Dismiss retained history notice" }).click();
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain("composer-controls");
  expect(document.body.textContent).toContain("transcript");
  expect(props.base.activeThread?.error).toBe("source error remains");
  expect(state.retained).toBe("This transcript is retained read-only history.");
});

it("wires setup dismissal to the active thread and the actual setup revision", async () => {
  state.setupError =
    "V2 selected thread has no supported local native Location; no local/private fallback.";
  const props = makeProps();
  const first = await render(<ChatViewChatBody {...props} />);
  await page.getByRole("button", { name: "Dismiss OpenCode setup notice" }).click();
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  expect(props.base.activeThread?.error).toBe("source error remains");
  await first.unmount();
  const reopened = await render(<ChatViewChatBody {...props} />);
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  await reopened.rerender(<ChatViewChatBody {...makeProps("thread-two")} />);
  await expect.element(page.getByText(state.setupError)).toBeVisible();
  state.revision = "two";
  await reopened.rerender(<ChatViewChatBody {...props} />);
  await expect.element(page.getByText(state.setupError)).toBeVisible();
});
