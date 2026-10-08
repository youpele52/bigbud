import { expect, it } from "vitest";
import type { ServerProvider } from "@bigbud/contracts";
import {
  resolveMobileComposerModelSelection,
  getProviderSnapshotForMobile,
} from "./mobileModelSelection.logic";

it("permits configured V2 preview selections without a hidden flag and retains identity without automatic selection", () => {
  const provider: ServerProvider = {
    provider: "opencodeV2",
    enabled: true,
    installed: true,
    version: "2.0.19",
    status: "ready",
    auth: { status: "unknown" },
    checkedAt: "fixture",
    models: [
      {
        slug: "native",
        name: "Native",
        subProviderID: "isolated",
        isCustom: false,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
  };
  const development = provider;
  const context = {
    thread: null,
    draft: null,
    project: null,
    providers: [development],
    isRunning: false,
  };
  expect(resolveMobileComposerModelSelection(context, null).provider).not.toBe("opencodeV2");
  expect(getProviderSnapshotForMobile([development], "opencodeV2")?.provider).toBe("opencodeV2");
  const selection = { provider: "opencodeV2" as const, model: "native", subProviderID: "isolated" };
  expect(resolveMobileComposerModelSelection(context, selection)).toEqual(selection);
});
