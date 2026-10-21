/**
 * Required per-provider subagent capability declarations.
 *
 * Every `ProviderKind` must have an entry (a missing one is a type error), and every
 * production adapter must expose its entry as `capabilities.subagents`. The conformance
 * test (`providerSubagents.conformance.test.ts`) fails when an adapter does not declare
 * its capability, or declares `native` without mapping tests.
 *
 * - `native`: the provider exposes subagent data and the adapter maps it with
 *   `providerSubagentEvent` (or, for Claude, its task reducer over the same shared helpers).
 * - `gated`: data exists, but a documented safety or verification gate keeps it closed.
 * - `none`: the provider protocol exposes no subagent or child-task data.
 *
 * @module providerSubagents.capabilities
 */
import type { ProviderKind } from "@bigbud/contracts";

export type ProviderSubagentSupport = "native" | "none" | "gated";

/** Subagent fields an adapter can supply; absent fields are shown as absent, never invented. */
export type ProviderSubagentField =
  | "status"
  | "subject"
  | "model"
  | "effort"
  | "prompt"
  | "depth"
  | "nesting"
  | "background"
  | "metrics"
  | "recentSteps"
  | "lastToolName"
  | "progressSummary"
  | "resultSummary"
  | "endedAt";

export interface ProviderSubagentCapability {
  readonly support: ProviderSubagentSupport;
  /** Fields the mapping supplies when the provider reports them. Empty unless native. */
  readonly fields: ReadonlyArray<ProviderSubagentField>;
  /** Native surface, or why the provider is `none`/`gated` (types, docs or protocol). */
  readonly evidence: string;
  /** Test files (relative to `apps/server/src`) proving the mapping or the gate. */
  readonly tests: ReadonlyArray<string>;
  /** Per-subagent Stop through the adapter's `stopSubagent` (D3). */
  readonly stop?: boolean;
}

const OPENCODE_V1_CHILDREN: ProviderSubagentCapability = {
  support: "native",
  fields: [
    "status",
    "subject",
    "model",
    "metrics",
    "recentSteps",
    "lastToolName",
    "progressSummary",
  ],
  evidence:
    "@opencode-ai/sdk child sessions: session.children, session.created/updated parentID, child messages (modelID, providerID, tokens, cost) and tool parts.",
  tests: ["provider/Layers/Opencode/Adapter.stream.children.fields.test.ts"],
};

export const PROVIDER_SUBAGENT_CAPABILITIES: {
  readonly [Provider in ProviderKind]: ProviderSubagentCapability;
} = {
  claudeAgent: {
    support: "native",
    fields: [
      "status",
      "subject",
      "model",
      "effort",
      "prompt",
      "depth",
      "nesting",
      "background",
      "metrics",
      "recentSteps",
      "lastToolName",
      "progressSummary",
      "resultSummary",
      "endedAt",
    ],
    evidence:
      "@anthropic-ai/claude-agent-sdk 0.3.301: task_* system messages, background_tasks_changed, subagent frames (agent_id), Agent tool input and AgentOutput, AgentInfo.model.",
    tests: [
      "provider/Layers/Claude/Adapter.stream.subagents.replay.test.ts",
      "provider/Layers/Claude/Adapter.stream.subagents.test.ts",
      "provider/Layers/Claude/Adapter.controls.subagents.test.ts",
    ],
    stop: true,
  },
  cliProxy: {
    support: "gated",
    fields: [],
    evidence:
      "Shares the Claude adapter, but the CLIProxyAPI harness has no verified subagent frames; providerSubagentsSupported stays false, so every task stays an ordinary task (D11).",
    tests: ["provider/Layers/Claude/Adapter.stream.subagents.replay.test.ts"],
  },
  codex: {
    support: "native",
    fields: [
      "status",
      "subject",
      "model",
      "effort",
      "prompt",
      "depth",
      "nesting",
      "recentSteps",
      "lastToolName",
      "resultSummary",
      "endedAt",
    ],
    evidence:
      "codex app-server 0.162.1 generated types: ThreadItem collabAgentToolCall (tool, receiverThreadIds, prompt, model, reasoningEffort, agentsStates) and subAgentActivity (kind, agentThreadId, agentPath, model, reasoningEffort).",
    tests: [
      "provider/Layers/Codex/Adapter.stream.subagents.test.ts",
      "provider/Layers/Codex/Adapter.stream.subagents.adapter.test.ts",
    ],
  },
  copilot: {
    support: "native",
    fields: [
      "status",
      "subject",
      "model",
      "metrics",
      "recentSteps",
      "lastToolName",
      "progressSummary",
      "endedAt",
    ],
    evidence:
      "@github/copilot-sdk 1.0.7 session-events: subagent.started/completed/failed (agentName, model, totalTokens, totalToolCalls, durationMs, error) and agentId-tagged tool.execution_start/complete.",
    tests: ["provider/Layers/Copilot/Adapter.mapEvent.subagents.test.ts"],
  },
  cursor: {
    support: "none",
    fields: [],
    evidence:
      "Cursor CLI via ACP: session/update kinds are agent/user message and thought chunks, tool_call(_update), plan, usage, mode, config, commands and session info; the only extensions are cursor/ask_question, cursor/create_plan and cursor/update_todos. No subagent or child-session data.",
    tests: [],
  },
  devin: {
    support: "none",
    fields: [],
    evidence:
      "Devin CLI via ACP: the same session/update kinds as every ACP agent and no extension methods. No subagent or child-session data.",
    tests: [],
  },
  kilocode: OPENCODE_V1_CHILDREN,
  opencode: OPENCODE_V1_CHILDREN,
  opencodeV2: {
    support: "gated",
    fields: [],
    evidence:
      "Repository source implements the pre-execution permission ceiling, exact child routing, durable family Stop/physical-drain authority and cardless SQL-hydrated Stop. The portable v2.0.26 native-family patch supplies authenticated completion admission; stock native lacks that primitive. Source-only checks/review do not qualify a runtime: isolation, release and exact native-family qualification registries remain empty, so production stays gated (docs/validation/opencode-v2-subagent-evidence-2026-10-16.md).",
    tests: [
      "provider/Layers/OpencodeV2/Runtime.subagents.test.ts",
      "provider/Layers/OpencodeV2/Runtime.subagents.observations.test.ts",
      "provider/Layers/OpencodeV2/Runtime.subagents.read.test.ts",
      "provider/Layers/OpencodeV2/Runtime.subagents.http.test.ts",
      "provider/Layers/OpencodeV2/Subagents.prerequisites.test.ts",
      "provider/Layers/OpencodeV2/Runtime.family.execution.test.ts",
    ],
  },
  pi: {
    support: "native",
    fields: [
      "status",
      "subject",
      "model",
      "prompt",
      "nesting",
      "background",
      "metrics",
      "recentSteps",
      "lastToolName",
      "progressSummary",
      "resultSummary",
      "endedAt",
    ],
    evidence:
      "Pi 0.80.3 subagent extension: subagent tool details.results (agent, task, model, messages, usage) and the subagent-async widget snapshot (state, currentTool, toolCount, timestamps).",
    tests: [
      "provider/Layers/Pi/Adapter.stream.subagents.fields.test.ts",
      "provider/Layers/Pi/Adapter.stream.asyncSubagents.test.ts",
    ],
  },
};
