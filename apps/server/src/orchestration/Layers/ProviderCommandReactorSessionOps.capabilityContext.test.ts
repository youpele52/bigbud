import { describe, expect, it } from "vitest";

import type { OrchestrationThread } from "@bigbud/contracts";

import { BIGBUD_CAPABILITY_CATALOG } from "../../capabilities/BigbudCapabilityTracks.ts";
import {
  buildCapabilityAwareProviderInput,
  createProviderCapabilityContextState,
} from "./ProviderCommandReactorSessionOps.capabilityContext.ts";

const thread = {
  id: "thread-capability-context",
  title: "Capability context",
  runtimeMode: "full-access",
  modelSelection: { provider: "codex", model: "gpt-5" },
  activities: [],
} as unknown as OrchestrationThread;

const buildInput = (
  state: ReturnType<typeof createProviderCapabilityContextState>,
  memoryContext = "",
) =>
  buildCapabilityAwareProviderInput({
    providerInputText: "User prompt",
    catalog: BIGBUD_CAPABILITY_CATALOG,
    thread,
    memoryContext,
    contextRole: "main",
    state,
  });

describe("provider capability context", () => {
  it("sends one LP and Skits on finalized human prompts 5, 10, and so on", () => {
    const state = createProviderCapabilityContextState();
    const prompts = Array.from({ length: 12 }, () => buildInput(state));

    expect(prompts[0]).toContain("<bigbud_capability_lp>");
    expect(prompts[0]).not.toContain("<bigbud_capability_skit>");
    expect(prompts[4]).toContain("<bigbud_capability_skit>");
    expect(prompts[9]).toContain("<bigbud_capability_skit>");
    expect(prompts[1]).not.toContain("<bigbud_capability_");
  });

  it("injects memory initially and only when its bounded content changes", () => {
    const state = createProviderCapabilityContextState();

    expect(buildInput(state, "Remember alpha.")).toContain("Remember alpha.");
    expect(buildInput(state, "Remember alpha.")).not.toContain("Remember alpha.");
    expect(buildInput(state, "Remember beta.")).toContain("Remember beta.");
    expect(buildInput(state, "Remember beta.")).not.toContain("Remember beta.");
  });

  it("starts an independent cadence after an epoch reset", () => {
    const firstEpoch = createProviderCapabilityContextState();
    Array.from({ length: 7 }, () => buildInput(firstEpoch));

    const secondEpoch = createProviderCapabilityContextState();
    expect(buildInput(secondEpoch)).toContain("<bigbud_capability_lp>");
    expect(Array.from({ length: 3 }, () => buildInput(secondEpoch))[2]).not.toContain(
      "<bigbud_capability_skit>",
    );
    expect(buildInput(secondEpoch)).toContain("<bigbud_capability_skit>");
  });

  it("refreshes the LP and memory after a provider compaction signal", () => {
    const state = createProviderCapabilityContextState();
    buildInput(state, "Remember alpha.");
    buildInput(state, "Remember alpha.");

    const compactedThread = {
      ...thread,
      activities: [{ id: "compaction-1", kind: "context-compaction" }],
    } as unknown as OrchestrationThread;
    const result = buildCapabilityAwareProviderInput({
      providerInputText: "After compaction",
      catalog: BIGBUD_CAPABILITY_CATALOG,
      thread: compactedThread,
      memoryContext: "Remember alpha.",
      contextRole: "main",
      state,
    });

    expect(result).toContain("<bigbud_capability_lp>");
    expect(result).toContain("Remember alpha.");
  });

  it("sends a bounded delta when MCP availability changes", () => {
    const state = createProviderCapabilityContextState();
    buildInput(state);
    state.lastMcpStatusActivityId = "mcp-status-1";
    const changedThread = {
      ...thread,
      activities: [{ id: "mcp-status-2", kind: "mcp.status.updated" }],
    } as unknown as OrchestrationThread;

    const result = buildCapabilityAwareProviderInput({
      providerInputText: "Use GitHub",
      catalog: BIGBUD_CAPABILITY_CATALOG,
      thread: changedThread,
      memoryContext: "",
      contextRole: "main",
      state,
    });

    expect(result).toContain("<bigbud_capability_delta>");
    expect(result).not.toContain("<bigbud_capability_skit>");
  });

  it("keeps 100-prompt LP and Skit overhead bounded", () => {
    const state = createProviderCapabilityContextState();
    const prompts = Array.from({ length: 100 }, () => buildInput(state));

    expect(prompts.filter((prompt) => prompt.includes("<bigbud_capability_lp>"))).toHaveLength(1);
    expect(prompts.filter((prompt) => prompt.includes("<bigbud_capability_skit>"))).toHaveLength(
      20,
    );
  });
});
