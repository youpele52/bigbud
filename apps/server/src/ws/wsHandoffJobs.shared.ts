import { Schema } from "effect";
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  type CodexModelSelection,
  type ClaudeModelSelection,
  type ModelSelection,
} from "@bigbud/contracts";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import { serializeThreadContextMarkdown } from "../orchestration/ThreadContextExport.ts";
import {
  resolveThreadWorkflowStatus,
  serializeThreadWorkflowStatusMarkdown,
} from "../orchestration/ThreadWorkflowStatus.logic.ts";
import { normalizeTextGenerationModelSelection } from "../git/Layers/RoutingTextGeneration.ts";

export const HANDOFF_TIMEOUT_MS = 180_000;
const HANDOFF_CHUNK_MAX_CHARS = 16_000;

export const HandoffOutputSchema = Schema.Struct({
  markdown: Schema.String,
});

export const ClaudeOutputEnvelope = Schema.Struct({
  structured_output: HandoffOutputSchema,
});

export function normalizeHandoffModelSelection(
  modelSelection: ModelSelection,
): CodexModelSelection | ClaudeModelSelection {
  const normalized = normalizeTextGenerationModelSelection(modelSelection);
  if (normalized.provider === "claudeAgent") {
    return normalized;
  }

  if (normalized.provider === "codex") {
    return normalized;
  }

  return {
    provider: "codex",
    model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex,
  } satisfies CodexModelSelection;
}

export function chunkMarkdown(value: string): ReadonlyArray<string> {
  const chunks: string[] = [];
  let current = "";

  for (const block of value.split(/\n{2,}/g)) {
    const nextBlock = block.trim();
    if (nextBlock.length === 0) {
      continue;
    }
    const candidate = current.length === 0 ? nextBlock : `${current}\n\n${nextBlock}`;
    if (candidate.length <= HANDOFF_CHUNK_MAX_CHARS) {
      current = candidate;
      continue;
    }
    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }
    if (nextBlock.length <= HANDOFF_CHUNK_MAX_CHARS) {
      current = nextBlock;
      continue;
    }
    for (let start = 0; start < nextBlock.length; start += HANDOFF_CHUNK_MAX_CHARS) {
      chunks.push(nextBlock.slice(start, start + HANDOFF_CHUNK_MAX_CHARS));
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks.length > 0 ? chunks : [value];
}

export function buildHandoffPrompt(input: {
  readonly context: string;
  readonly focus?: string | undefined;
  readonly mode: "chunk" | "final";
}): string {
  const focusSection = input.focus ? [`Next session focus: ${input.focus}`, ""] : [];
  const modeInstruction =
    input.mode === "chunk"
      ? "Summarize only the facts from this slice of a longer coding thread."
      : "Write the final handoff document for a fresh coding thread.";

  return [
    "You write clean engineering handoff documents.",
    "Return a JSON object with key: markdown.",
    modeInstruction,
    "Rules:",
    "- Use markdown.",
    "- Keep the writing compact and concrete.",
    "- Preserve important technical details, decisions, current state, failures, and next steps.",
    "- Do not invent work, files, commands, or outcomes.",
    "- Reference artifacts and file paths when they are present in the source material.",
    "- Do not include a suggested skills section.",
    ...(input.mode === "chunk"
      ? [
          "- Use these headings when supported by the source: Current Objective, Decisions, Files, Open Work, Risks, References.",
          "- Omit empty headings.",
        ]
      : [
          "- Use these headings in this order when supported by the source: Current Objective, Current State, Important Decisions, Files and Artifacts, Open Issues, Next Steps.",
          "- Omit empty headings.",
        ]),
    "",
    ...focusSection,
    "Source material:",
    input.context,
  ].join("\n");
}

export function buildThreadSnapshotMarkdown(
  thread: Parameters<typeof resolveThreadWorkflowStatus>[0],
): string {
  const workflowStatus = resolveThreadWorkflowStatus(thread);
  const threadMetadata = [
    "### Thread metadata",
    `- Thread title: ${thread.title}`,
    ...(thread.branch ? [`- Branch: ${thread.branch}`] : []),
    ...(thread.worktreePath ? [`- Worktree path: ${thread.worktreePath}`] : []),
    ...(thread.elevatorSummary ? [`- Elevator summary: ${thread.elevatorSummary}`] : []),
  ].join("\n");

  return [
    threadMetadata,
    "",
    serializeThreadWorkflowStatusMarkdown(workflowStatus),
    "",
    serializeThreadContextMarkdown({
      id: thread.id,
      title: thread.title,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      messages: thread.messages,
    }),
  ].join("\n");
}

export function resolveHandoffCwd(input: {
  readonly thread: Parameters<typeof resolveThreadWorkflowStatus>[0];
  readonly projects: ReadonlyArray<{
    readonly id: string;
    readonly workspaceRoot: string | null;
  }>;
  readonly defaultChatCwd: string;
}): string {
  const project = input.projects.find((entry) => entry.id === input.thread.projectId);
  return (
    resolveThreadWorkspaceCwd({
      thread: input.thread,
      projects: input.projects as unknown as Parameters<
        typeof resolveThreadWorkspaceCwd
      >[0]["projects"],
    }) ??
    project?.workspaceRoot ??
    input.defaultChatCwd
  );
}
