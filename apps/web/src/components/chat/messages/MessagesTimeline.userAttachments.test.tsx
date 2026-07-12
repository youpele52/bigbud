import { ThreadId } from "@bigbud/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useStore } from "~/stores/main";
import { makeState, makeThread } from "~/stores/main/main.store.test.helpers";
import { useSideChatStore } from "~/stores/sideChat";

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

import { UserThreadReferenceChips } from "./MessagesTimeline.userAttachments";

describe("UserThreadReferenceChips", () => {
  beforeEach(() => {
    navigateMock.mockReset();
    const thread = makeThread();
    useStore.setState({
      ...makeState(thread),
      sidebarThreadsById: {},
      threadIdsByProjectId: {},
      threads: [],
    });
    useSideChatStore.setState({
      closedThreadId: null,
      closeStartedAt: null,
      deletionRequested: false,
      presentation: "open",
      threadId: null,
    });
  });

  it("navigates to the attached thread when clicked", () => {
    const element = UserThreadReferenceChips({
      threads: [
        {
          type: "thread",
          id: "attachment-thread-1",
          name: "loliiiie",
          mimeType: "application/x-bigbud-thread-reference",
          sizeBytes: 0,
          threadId: ThreadId.makeUnsafe("thread-loliiiie"),
          title: "loliiiie",
        },
      ],
    });
    const button = Array.isArray(element?.props.children)
      ? element.props.children[0]
      : element?.props.children;

    button.props.onClick();

    expect(navigateMock).toHaveBeenCalledWith({
      to: "/$threadId",
      params: { threadId: ThreadId.makeUnsafe("thread-loliiiie") },
    });
  });

  it("restores a live Sidecar attachment instead of navigating to it", () => {
    const sidecarThreadId = ThreadId.makeUnsafe("sidecar-thread");
    const sidecar = makeThread({ id: sidecarThreadId, purpose: "side-chat" });
    useStore.setState({ ...makeState(sidecar), threads: [sidecar] });
    const element = UserThreadReferenceChips({
      threads: [
        {
          type: "thread",
          id: "attachment-sidecar",
          name: "Sidecar",
          mimeType: "application/x-bigbud-thread-reference",
          sizeBytes: 0,
          threadId: sidecarThreadId,
          title: "Sidecar",
        },
      ],
    });
    const button = Array.isArray(element?.props.children)
      ? element.props.children[0]
      : element?.props.children;

    button.props.onClick();

    expect(navigateMock).not.toHaveBeenCalled();
    expect(useSideChatStore.getState()).toMatchObject({
      presentation: "open",
      threadId: sidecarThreadId,
    });
  });
});
