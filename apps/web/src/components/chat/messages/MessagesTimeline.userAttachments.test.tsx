import { ThreadId } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

import { UserThreadReferenceChips } from "./MessagesTimeline.userAttachments";

describe("UserThreadReferenceChips", () => {
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
});
