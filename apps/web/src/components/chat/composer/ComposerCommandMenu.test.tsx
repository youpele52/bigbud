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

  it("renders the discovery searchbar for model browsing", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "model:opencode:default:gpt-5",
            type: "model",
            provider: "opencode",
            model: "gpt-5",
            label: "GPT-5",
            description: "OpenCode · gpt-5",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-model"
        discoverySearch={{ command: "model", query: "gpt", onQueryChange: vi.fn() }}
        activeItemId={null}
        onHighlightedItemChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(markup).toContain("Search models");
    expect(markup).toContain("Models");
    expect(markup).toContain("GPT-5");
  });

  it("renders an open-source action for discovery items with source paths", () => {
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
              sourcePath: "/Users/alice/.config/opencode/agents/reviewer.md",
              description: "Reviews code changes.",
            },
            label: "reviewer",
            description: "Reviews code changes.",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        discoverySearch={{ command: "agents", query: "", onQueryChange: vi.fn() }}
        activeItemId={null}
        onHighlightedItemChange={vi.fn()}
        onSelect={vi.fn()}
        onOpenItemSourcePath={vi.fn()}
      />,
    );

    expect(markup).toContain("Open source file");
  });
});
