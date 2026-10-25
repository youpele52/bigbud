import { LEGACY_OPENCODE_READ_ONLY_MESSAGE } from "@bigbud/shared/providerLifecycle";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ChatViewChatBody } from "./ChatViewChatBody";
import { ChatViewMainComposer } from "./ChatViewMainComposer";

vi.mock("~/hooks/useThreadActions", () => ({ useThreadActions: () => ({}) }));
vi.mock("./ChatViewContent.handlers", () => ({ useChatViewContentHandlers: () => ({}) }));
vi.mock("~/components/git/BranchToolbar", () => ({ default: () => "branch-toolbar" }));
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
vi.mock("./ChatViewComposer", () => ({ ChatViewComposer: () => "composer-controls" }));
vi.mock("../../side-chat/SideChatHost", () => ({ SideChatHost: () => null }));
vi.mock("../../side-chat/sideChat.actions", () => ({ openSideChat: vi.fn() }));
// Router-bound recovery and fork notices are covered by their own tests.
vi.mock("../ThreadRecoveryNotices", () => ({ ThreadRecoveryNotices: () => null }));

function makeProps(provider: "opencode" | "opencodeV2") {
  return {
    base: {
      activeThread: { id: "thread-1", modelSelection: { provider }, error: null, activities: [] },
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

describe("legacy OpenCode warning placement", () => {
  it("renders the warning once above the transcript and never in the bottom composer", () => {
    const props = makeProps("opencode");
    const markup = renderToStaticMarkup(<ChatViewChatBody {...props} />);

    expect(markup.split(LEGACY_OPENCODE_READ_ONLY_MESSAGE)).toHaveLength(2);
    expect(markup.indexOf(LEGACY_OPENCODE_READ_ONLY_MESSAGE)).toBeLessThan(
      markup.indexOf("transcript"),
    );
    expect(markup).toContain("branch-toolbar");
    expect(markup).not.toContain("composer-controls");
    expect(
      renderToStaticMarkup(<ChatViewMainComposer {...props} onOpenReplySource={vi.fn()} />),
    ).toBe("");
  });

  it("keeps V2 chats editable without the legacy warning", () => {
    const markup = renderToStaticMarkup(<ChatViewChatBody {...makeProps("opencodeV2")} />);

    expect(markup).not.toContain(LEGACY_OPENCODE_READ_ONLY_MESSAGE);
    expect(markup).toContain("composer-controls");
  });
});
