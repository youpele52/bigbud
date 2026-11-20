import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatGreeting } from "~/components/chat/common/ChatGreeting";

import { MobileMessages } from "./MobileMessages";

describe("current desktop/mobile empty conversation greeting", () => {
  it("shows the same eligible greeting as the actual desktop presentation", () => {
    const greeting = "What shall we build this evening?";
    const desktop = renderToStaticMarkup(<ChatGreeting greeting={greeting} />);
    const mobile = renderToStaticMarkup(
      <MobileMessages messages={[]} cwd={undefined} showEmptyState greeting={greeting} />,
    );
    expect(desktop).toContain(greeting);
    expect(mobile).toContain(greeting);
  });

  it("preserves logo-only empty presentation when no copy is selected", () => {
    const mobile = renderToStaticMarkup(
      <MobileMessages messages={[]} cwd={undefined} showEmptyState greeting={null} />,
    );
    expect(mobile).toContain('aria-label="No messages yet"');
    expect(mobile).toContain("opacity-70");
    expect(mobile).not.toMatch(/<p(?:\s|>)/);
  });
});
