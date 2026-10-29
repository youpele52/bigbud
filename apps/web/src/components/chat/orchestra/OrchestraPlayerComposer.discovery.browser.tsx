import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useOrchestraPlayerComposer } from "./OrchestraPlayerComposer.logic";

vi.mock("./OrchestraPlayerComposer.visibility", () => ({
  useOrchestraComposerProviderVisibility: () => ({
    selectedProvider: "codex",
    hiddenComposerProviders: [],
  }),
}));

function DiscoveryHarness({ initialPrompt }: { initialPrompt: string }) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const composer = useOrchestraPlayerComposer({
    assignment: { prompt, modelSelection: { provider: "codex", model: "gpt-5.4" } },
    providers: [],
    modelOptionsByProvider: {
      codex: [],
      claudeAgent: [],
      opencodeV2: [],
      cliProxy: [],
      copilot: [],
      opencode: [],
      pi: [],
      cursor: [],
      devin: [],
      muse: [],
    },
    discoveredAgents: [{ id: "review", name: "review", provider: "codex", source: "user" }],
    discoveredSkills: [{ id: "handoff", name: "handoff", provider: "bigbud", source: "project" }],
    activeProjectCwd: null,
    onChange: (update) => {
      if (update.prompt !== undefined) setPrompt(update.prompt);
    },
  });
  return (
    <>
      <output data-testid="prompt">{prompt}</output>
      {composer.composerMenuItems.map((item) => (
        <button key={item.id} onClick={() => composer.onSelectComposerItem(item)}>
          {item.label}
        </button>
      ))}
    </>
  );
}

it.each([
  { initialPrompt: "@", label: "@review", expectedPrompt: "@agent::review " },
  { initialPrompt: "/skills ", label: "handoff", expectedPrompt: "@skill::handoff " },
])(
  "preserves orchestra direct discovery selection from $initialPrompt",
  async ({ initialPrompt, label, expectedPrompt }) => {
    await render(
      <QueryClientProvider client={new QueryClient()}>
        <DiscoveryHarness initialPrompt={initialPrompt} />
      </QueryClientProvider>,
    );
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect.element(page.getByTestId("prompt")).toHaveTextContent(expectedPrompt.trim());
  },
);

it("does not offer a marketplace command in the orchestra slash menu", async () => {
  await render(
    <QueryClientProvider client={new QueryClient()}>
      <DiscoveryHarness initialPrompt="/" />
    </QueryClientProvider>,
  );
  await expect.element(page.getByRole("button", { name: "/skills", exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "/agents", exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "/plugins", exact: true }))
    .not.toBeInTheDocument();
});
