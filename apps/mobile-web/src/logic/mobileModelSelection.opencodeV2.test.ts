import { expect, it } from "vitest";
import { Schema } from "effect";
import { OrchestrationThread, type ServerProvider } from "@bigbud/contracts";
import {
  resolveMobileComposerModelSelection,
  getProviderSnapshotForMobile,
} from "./mobileModelSelection.logic";

it("permits configured V2 preview selections without a hidden flag and retains identity without automatic selection", () => {
  const provider: ServerProvider = {
    provider: "opencodeV2",
    enabled: true,
    installed: true,
    version: "2.0.26",
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
  const saved = { ...selection, options: { variant: "precise" } };
  const thread = Schema.decodeUnknownSync(OrchestrationThread)({
    id: "saved-v2",
    projectId: "project",
    title: "Historical V2",
    modelSelection: saved,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-10-08T00:00:00Z",
    updatedAt: "2026-10-08T00:00:00Z",
    deletedAt: null,
    messages: [],
    activities: [],
    checkpoints: [],
    session: null,
    proposedPlans: [],
    turns: [],
  });
  for (const providers of [
    [],
    [{ ...provider, enabled: false }],
    [{ ...provider, status: "error" as const }],
  ]) {
    expect(resolveMobileComposerModelSelection({ ...context, thread, providers }, null)).toEqual(
      saved,
    );
  }
});
