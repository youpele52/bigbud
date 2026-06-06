import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ComposerCommandMenu } from "./ComposerCommandMenu";

describe("ComposerCommandMenu", () => {
  it("renders the discovery searchbar for agent browsing", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "slash-agent:opencode:reviewer",
            type: "agent",
            agent: {
              id: "reviewer",
              provider: "opencode",
              name: "reviewer",
              source: "user",
              description: "Reviews code changes.",
            },
            label: "reviewer",
            description: "Reviews code changes.",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        discoverySearch={{ command: "agents", query: "rev", onQueryChange: vi.fn() }}
        activeItemId={null}
        onHighlightedItemChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(markup).toContain("Search agents");
    expect(markup).toContain("Agents");
    expect(markup).toContain("reviewer");
  });
});
