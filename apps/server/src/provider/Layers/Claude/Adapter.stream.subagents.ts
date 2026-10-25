/**
 * Claude provider-subagent detail from the subagent's own frames: model, tool steps,
 * heartbeats, the Agent tool's input and its `AgentOutput`.
 *
 * Every path is gated by `context.providerSubagentsSupported` (D11), so an unsupported harness
 * (CLIProxy) never gains subagent fields.
 *
 * @module ClaudeAdapter.stream.subagents
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { EventId } from "@bigbud/contracts";
import {
  appendSubagentStep,
  boundSubagentText,
  completeSubagentStep,
} from "@bigbud/shared/providerSubagents";
import { Effect } from "effect";

import type { OfferClaudeRuntimeEvent } from "./Adapter.events.ts";
import { asRecord } from "./Adapter.sdk.messages.ts";
import { isClaudeProviderSubagent } from "./Adapter.tasks.classify.ts";
import type { ClaudeTask } from "./Adapter.tasks.types.ts";
import { updateClaudeTaskPlan } from "./Adapter.stream.tasks.ts";
import type { ClaudeAgentToolInput, ClaudeSessionContext } from "./Adapter.types.ts";
import {
  classifyToolItemType,
  summarizeToolRequest,
  titleForTool,
  toolResultBlocksFromUserMessage,
} from "./Adapter.utils.ts";

const AGENT_TOOL_NAMES = new Set(["Agent", "Task"]);
const MAX_PENDING_AGENT_INPUTS = 64;

export const isClaudeAgentTool = (toolName: string) => AGENT_TOOL_NAMES.has(toolName);

/** Removes and returns the Agent tool hints recorded for `task_started`'s tool-use ID. */
export function takeAgentToolInput(
  context: ClaudeSessionContext,
  toolUseId: string,
): ClaudeAgentToolInput {
  const input = context.agentToolInputs.get(toolUseId) ?? {};
  context.agentToolInputs.delete(toolUseId);
  return input;
}

function agentToolInput(input: Record<string, unknown>): ClaudeAgentToolInput {
  const model = boundSubagentText(input.model, "model");
  const effort = boundSubagentText(input.effort, "effort");
  const prompt = boundSubagentText(input.prompt, "prompt");
  const subagentType = boundSubagentText(input.subagent_type, "subject");
  return {
    ...(model ? { requested_model: model } : {}),
    ...(effort ? { effort } : {}),
    ...(prompt ? { prompt } : {}),
    ...(subagentType ? { subagent_type: subagentType } : {}),
  };
}

/** Finds a classified subagent by `agent_id` (its task ID), else by its spawning tool use. */
export function findClaudeSubagentTask(
  context: ClaudeSessionContext,
  ref: { readonly agentId?: string | null | undefined; readonly toolUseId?: string | null },
): ClaudeTask | undefined {
  const isSubagent = (task: ClaudeTask | undefined): task is ClaudeTask =>
    task !== undefined && isClaudeProviderSubagent(task, context.providerSubagentsSupported);
  const byAgent = ref.agentId ? context.taskState.tasks.get(ref.agentId) : undefined;
  if (isSubagent(byAgent)) return byAgent;
  if (!ref.toolUseId) return undefined;
  return Array.from(context.taskState.tasks.values()).find(
    (task) =>
      isSubagent(task) &&
      (task.sourceToolUseId === ref.toolUseId || task.parentToolUseId === ref.toolUseId),
  );
}

function stepLabel(toolName: string, input: unknown): string {
  const record = asRecord(input);
  return (
    (record ? summarizeToolRequest(toolName, record) : undefined) ||
    titleForTool(classifyToolItemType(toolName))
  );
}

export function makeSubagentHandlers(deps: {
  readonly makeEventStamp: () => Effect.Effect<{ eventId: EventId; createdAt: string }>;
  readonly offerRuntimeEvent: OfferClaudeRuntimeEvent;
  readonly nowIso: Effect.Effect<string>;
}) {
  const update = (
    context: ClaudeSessionContext,
    task: ClaudeTask,
    toolUseId: string,
    input: Record<string, unknown>,
  ) =>
    Object.keys(input).length === 0
      ? Effect.void
      : Effect.flatMap(deps.nowIso, (now) =>
          updateClaudeTaskPlan({
            context,
            toolUseId,
            toolName: "task_updated",
            input: { task_id: task.id, ...input },
            now,
            makeEventStamp: deps.makeEventStamp,
            offerRuntimeEvent: deps.offerRuntimeEvent,
          }),
        );

  /** Agent/Task tool input at `content_block_stop`; held until its `task_started`. */
  const recordAgentToolInput = Effect.fn("recordClaudeAgentToolInput")(function* (
    context: ClaudeSessionContext,
    toolUseId: string,
    input: Record<string, unknown>,
  ) {
    if (!context.providerSubagentsSupported) return;
    const hints = agentToolInput(input);
    const task = findClaudeSubagentTask(context, { toolUseId });
    if (task) return yield* update(context, task, toolUseId, { ...hints });
    context.agentToolInputs.set(toolUseId, hints);
    if (context.agentToolInputs.size > MAX_PENDING_AGENT_INPUTS) {
      context.agentToolInputs.delete(context.agentToolInputs.keys().next().value!);
    }
  });

  /** Subagent assistant frame: first model, tool steps, and text only when forwarded. */
  const handleSubagentAssistant = Effect.fn("handleClaudeSubagentAssistant")(function* (
    context: ClaudeSessionContext,
    message: Extract<SDKMessage, { type: "assistant" }>,
    text: string,
  ) {
    const task = findClaudeSubagentTask(context, {
      agentId: message.agent_id,
      toolUseId: message.parent_tool_use_id,
    });
    if (!task) return;
    const at = yield* deps.nowIso;
    let steps = task.recentSteps;
    let lastToolName: string | undefined;
    const content = Array.isArray(message.message?.content) ? message.message.content : [];
    for (const block of content) {
      const record = asRecord(block);
      if (record?.type !== "tool_use" || typeof record.name !== "string") continue;
      steps = appendSubagentStep(steps, {
        ...(typeof record.id === "string" ? { id: record.id } : {}),
        toolName: record.name,
        label: stepLabel(record.name, record.input),
        status: "running",
        at,
      });
      lastToolName = record.name;
    }
    const model = boundSubagentText(message.message?.model, "model");
    const summary = context.forwardSubagentText
      ? boundSubagentText(text, "progressSummary")
      : undefined;
    yield* update(context, task, message.parent_tool_use_id ?? task.id, {
      ...(model && !task.observedModel ? { observed_model: model } : {}),
      ...(steps !== task.recentSteps ? { recent_steps: steps } : {}),
      ...(lastToolName ? { last_tool_name: lastToolName } : {}),
      ...(summary ? { progress_summary: summary } : {}),
    });
  });

  /** Subagent user frame: each `tool_result` completes or fails its step. */
  const handleSubagentUser = Effect.fn("handleClaudeSubagentUser")(function* (
    context: ClaudeSessionContext,
    message: Extract<SDKMessage, { type: "user" }>,
  ) {
    const task = findClaudeSubagentTask(context, {
      agentId: (message as { agent_id?: string }).agent_id,
      toolUseId: message.parent_tool_use_id,
    });
    if (!task?.recentSteps) return;
    let steps = task.recentSteps;
    for (const result of toolResultBlocksFromUserMessage(message)) {
      steps = completeSubagentStep(
        steps,
        result.toolUseId,
        result.isError ? "failed" : "completed",
      );
    }
    if (steps === task.recentSteps) return;
    yield* update(context, task, message.parent_tool_use_id ?? task.id, { recent_steps: steps });
  });

  /** `AgentOutput` on the Agent tool's result: resolved model and authoritative totals. */
  const recordAgentToolOutput = Effect.fn("recordClaudeAgentToolOutput")(function* (
    context: ClaudeSessionContext,
    toolUseId: string,
    toolUseResult: unknown,
  ) {
    const output = asRecord(toolUseResult);
    if (!output) return;
    const agentId = typeof output.agentId === "string" ? output.agentId : undefined;
    const task = findClaudeSubagentTask(context, { agentId, toolUseId });
    if (!task) return;
    const metrics = {
      ...(typeof output.totalTokens === "number" ? { totalTokens: output.totalTokens } : {}),
      ...(typeof output.totalToolUseCount === "number"
        ? { toolUses: output.totalToolUseCount }
        : {}),
      ...(typeof output.totalDurationMs === "number" ? { durationMs: output.totalDurationMs } : {}),
    };
    const resolvedModel = boundSubagentText(output.resolvedModel, "model");
    yield* update(context, task, toolUseId, {
      ...(resolvedModel ? { resolved_model: resolvedModel } : {}),
      ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
    });
  });

  /** `tool_progress` heartbeat from inside a subagent names its current tool. */
  const noteSubagentToolProgress = Effect.fn("noteClaudeSubagentToolProgress")(function* (
    context: ClaudeSessionContext,
    message: Extract<SDKMessage, { type: "tool_progress" }>,
  ) {
    if (!message.task_id && !message.parent_tool_use_id) return;
    const task = findClaudeSubagentTask(context, {
      agentId: message.task_id,
      toolUseId: message.parent_tool_use_id,
    });
    const toolName = boundSubagentText(message.tool_name, "toolName");
    if (!task || !toolName || task.lastToolName === toolName) return;
    yield* update(context, task, message.tool_use_id, { last_tool_name: toolName });
  });

  return {
    recordAgentToolInput,
    handleSubagentAssistant,
    handleSubagentUser,
    recordAgentToolOutput,
    noteSubagentToolProgress,
  };
}

export type SubagentHandlers = ReturnType<typeof makeSubagentHandlers>;

/** Best-effort read of `AgentInfo.model`; failures leave models unknown and never block. */
export const loadClaudeAgentModels = (context: ClaudeSessionContext) =>
  Effect.tryPromise(() => context.query.initializationResult()).pipe(
    Effect.map((result) => {
      const models = new Map<string, string>();
      for (const agent of result.agents ?? []) {
        if (typeof agent.model === "string" && agent.model.trim()) {
          models.set(agent.name, agent.model.trim());
        }
      }
      context.agentModels = models;
    }),
    Effect.ignore,
  );
