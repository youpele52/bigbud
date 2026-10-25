/**
 * Step ring for Pi async subagents. The widget reports only the current tool, so a step
 * starts when `currentTool` changes and the previous one is marked finished ("completed"
 * means it ended, not that it succeeded). Terminal states settle the running step.
 *
 * @module PiAdapter.stream.asyncSubagents.steps
 */
import {
  appendSubagentStep,
  completeSubagentStep,
  type ProviderSubagentStep,
} from "@bigbud/shared/providerSubagents";

import type { ActivePiSession } from "./Adapter.types.ts";

type Steps = ReadonlyArray<ProviderSubagentStep>;
const rings = new WeakMap<ActivePiSession, Map<string, Steps>>();
const MAX_RINGS = 128;

export function piAsyncSubagentSteps(input: {
  readonly session: ActivePiSession;
  readonly nativeId: string;
  readonly currentTool: string | undefined;
  readonly status: "pending" | "inProgress" | "completed" | "failed" | "stopped";
  readonly at: string;
  readonly revision: number;
}): Steps | undefined {
  const byNode = rings.get(input.session) ?? new Map<string, Steps>();
  rings.set(input.session, byNode);
  let steps = byNode.get(input.nativeId);
  const last = steps?.at(-1);
  const running = last?.status === "running" ? last : undefined;
  if (
    input.currentTool &&
    running?.toolName !== input.currentTool &&
    input.status === "inProgress"
  ) {
    if (running?.id) steps = completeSubagentStep(steps, running.id, "completed");
    steps = appendSubagentStep(steps, {
      id: `${input.nativeId}:${input.revision}`,
      toolName: input.currentTool,
      status: "running",
      at: input.at,
    });
  }
  const settled = steps?.at(-1);
  if (
    settled?.status === "running" &&
    settled.id &&
    (input.status === "completed" || input.status === "failed")
  )
    steps = completeSubagentStep(steps, settled.id, input.status);
  if (steps) {
    byNode.delete(input.nativeId);
    byNode.set(input.nativeId, steps);
    if (byNode.size > MAX_RINGS) byNode.delete(byNode.keys().next().value!);
  }
  return steps;
}

export function forgetPiAsyncSubagentSteps(session: ActivePiSession, nativeId: string) {
  rings.get(session)?.delete(nativeId);
}
