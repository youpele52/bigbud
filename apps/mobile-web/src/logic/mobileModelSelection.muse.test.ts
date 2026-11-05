import type { ServerProvider } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { resolveMobileComposerModelSelection } from "./mobileModelSelection.logic";

function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    provider: "muse",
    enabled: true,
    installed: true,
    status: "warning",
    auth: { status: "authenticated" },
    models: [
      {
        slug: "muse-spark-1.3-contributor",
        name: "muse-spark-1.3-contributor",
        isCustom: false,
        capabilities: null,
        subProviderID: "meta",
        contributorTraining: true,
      },
      {
        slug: "muse-spark-1.3",
        name: "muse-spark-1.3",
        isCustom: false,
        capabilities: null,
        subProviderID: "meta",
      },
    ],
    slashCommands: [],
    skills: [],
    ...overrides,
  } as ServerProvider;
}

const codex = {
  provider: "codex",
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  models: [{ slug: "gpt-5", name: "GPT-5", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
} as unknown as ServerProvider;

describe("mobile Muse selection", () => {
  it("never treats a warning Muse snapshot as runnable", () => {
    const selection = resolveMobileComposerModelSelection(
      {
        thread: null,
        draft: null,
        project: null,
        providers: [provider(), codex],
        isRunning: false,
      },
      null,
    );
    expect(selection.provider).toBe("codex");
  });

  it("preserves a saved Muse selection on an existing thread even when unavailable", () => {
    const thread = {
      id: "thread-1",
      modelSelection: { provider: "muse", model: "muse-spark-1.3", subProviderID: "meta" },
      latestTurn: null,
      session: null,
    } as never;
    const selection = resolveMobileComposerModelSelection(
      { thread, draft: null, project: null, providers: [provider()], isRunning: false },
      null,
    );
    expect(selection).toEqual({
      provider: "muse",
      model: "muse-spark-1.3",
      subProviderID: "meta",
    });
  });

  it("does not silently default to the Contributor model when Muse becomes ready", () => {
    const selection = resolveMobileComposerModelSelection(
      {
        thread: null,
        draft: null,
        project: null,
        providers: [provider({ status: "ready" })],
        isRunning: false,
      },
      null,
    );
    expect(selection).toEqual({
      provider: "muse",
      model: "muse-spark-1.3",
      subProviderID: "meta",
    });
  });
});
