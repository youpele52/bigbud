import { createHash } from "node:crypto";

import type { OrchestrationThread } from "@bigbud/contracts";

import type { CapabilityCatalog } from "../../capabilities/CapabilityCatalog.ts";
import {
  serializeCapabilityLp,
  serializeCapabilityDelta,
  serializeCapabilitySkit,
} from "../../capabilities/CapabilityCatalog.serialize.ts";

export const CAPABILITY_SKIT_PROMPT_INTERVAL = 5;

export interface ProviderCapabilityContextState {
  finalizedHumanPromptCount: number;
  hasObservedMcpStatus: boolean;
  lastCatalogRevision: string | null;
  lastCompactionActivityId: string | null;
  lastMcpStatusActivityId: string | null;
  lastMemoryHash: string | null;
  needsLp: boolean;
}

export const createProviderCapabilityContextState = (): ProviderCapabilityContextState => ({
  finalizedHumanPromptCount: 0,
  hasObservedMcpStatus: false,
  lastCatalogRevision: null,
  lastCompactionActivityId: null,
  lastMcpStatusActivityId: null,
  lastMemoryHash: null,
  needsLp: true,
});

const contentHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

const appendBlock = (text: string, block: string): string =>
  text.length > 0 ? `${block}\n\n${text}` : block;

export function buildCapabilityAwareProviderInput(input: {
  readonly providerInputText: string;
  readonly catalog: CapabilityCatalog;
  readonly thread: OrchestrationThread;
  readonly provider?: string;
  readonly model?: string;
  readonly memoryContext: string;
  readonly contextRole: "main" | "branch" | "delegated-child";
  readonly state: ProviderCapabilityContextState;
}): string {
  const latestCompactionActivityId =
    input.thread.activities.findLast((activity) => activity.kind === "context-compaction")?.id ??
    null;
  const latestMcpStatusActivityId =
    input.thread.activities.findLast((activity) => activity.kind === "mcp.status.updated")?.id ??
    null;
  const sendCapabilityDelta =
    !input.state.needsLp &&
    input.state.hasObservedMcpStatus &&
    (latestMcpStatusActivityId !== input.state.lastMcpStatusActivityId ||
      input.state.lastCatalogRevision !== input.catalog.revision);
  if (!input.state.needsLp && latestCompactionActivityId !== input.state.lastCompactionActivityId) {
    input.state.finalizedHumanPromptCount = 0;
    input.state.lastMemoryHash = null;
    input.state.needsLp = true;
  }
  input.state.lastCompactionActivityId = latestCompactionActivityId;
  input.state.lastMcpStatusActivityId = latestMcpStatusActivityId;
  input.state.hasObservedMcpStatus = true;
  input.state.lastCatalogRevision = input.catalog.revision;

  const sendLp = input.state.needsLp;
  input.state.finalizedHumanPromptCount += 1;

  let result = input.providerInputText;
  const memoryHash = contentHash(input.memoryContext);
  if (input.memoryContext.length > 0 && (sendLp || input.state.lastMemoryHash !== memoryHash)) {
    result = appendBlock(result, `Relevant persistent bigbud memory:\n${input.memoryContext}`);
  }
  input.state.lastMemoryHash = memoryHash;

  if (sendLp) {
    result = appendBlock(
      result,
      serializeCapabilityLp({
        catalog: input.catalog,
        context: {
          threadId: input.thread.id,
          threadTitle: input.thread.title,
          provider: input.provider ?? input.thread.modelSelection.provider,
          model: input.model ?? input.thread.modelSelection.model,
          runtimeMode: input.thread.runtimeMode,
          role: input.contextRole,
        },
      }),
    );
    input.state.needsLp = false;
  } else if (sendCapabilityDelta) {
    result = appendBlock(
      result,
      serializeCapabilityDelta(
        input.catalog.revision,
        "Effective skill, agent, or MCP capability availability changed during this context epoch.",
      ),
    );
  } else if (input.state.finalizedHumanPromptCount % CAPABILITY_SKIT_PROMPT_INTERVAL === 0) {
    result = appendBlock(result, serializeCapabilitySkit(input.catalog.revision));
  }

  return result;
}

export function prependCapabilityContextToProviderInput(input: {
  readonly providerInputText: string;
  readonly catalog: CapabilityCatalog;
  readonly thread: OrchestrationThread;
  readonly provider?: string;
  readonly model?: string;
  readonly memoryContext: string;
  readonly contextRole: "main" | "branch" | "delegated-child";
  readonly states: Map<string, ProviderCapabilityContextState>;
}): string {
  const state = input.states.get(input.thread.id) ?? createProviderCapabilityContextState();
  input.states.set(input.thread.id, state);
  return buildCapabilityAwareProviderInput({
    providerInputText: input.providerInputText,
    catalog: input.catalog,
    thread: input.thread,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    memoryContext: input.memoryContext,
    contextRole: input.contextRole,
    state,
  });
}
