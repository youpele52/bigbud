import type {
  ModelInfo as ClaudeModelInfo,
  OnElicitation,
  Options as ClaudeQueryOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { type ProviderSessionStartInput } from "@bigbud/contracts";
import { resolveApiModelId, resolveEffort, trimOrNull } from "@bigbud/shared/model";

import { getClaudeModelCapabilities } from "./Provider.ts";
import { CLAUDE_SETTING_SOURCES } from "./Adapter.utils.ts";
import { resolveBasePermissionMode } from "./Adapter.session.permissions.ts";
import { BIGBUD_CAPABILITY_CATALOG_PROTOCOL } from "../../../capabilities/CapabilityCatalog.serialize.ts";

interface BuildClaudeQueryOptionsInput {
  readonly input: ProviderSessionStartInput;
  readonly claudeBinaryPath: string;
  readonly orchestrationConfig: {
    readonly mcpServers: Record<string, unknown>;
    readonly allowedTools: ReadonlyArray<string>;
  };
  readonly runtimeCwd: string | undefined;
  readonly remoteQueryOptions: ClaudeQueryOptions | undefined;
  readonly hasRemoteWorkspaceBridge: boolean;
  readonly existingResumeSessionId: string | undefined;
  readonly resumeSessionAt: string | undefined;
  readonly newSessionId: string | undefined;
  readonly canUseTool: ClaudeQueryOptions["canUseTool"];
  readonly onElicitation?: OnElicitation;
  readonly boundedHookProgress: boolean;
  readonly forwardSubagentText: boolean;
  readonly settingSources?: ReadonlyArray<"user" | "project" | "local">;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** User-configured subagent caps (6.6); null or absent keeps the CLI default. */
  readonly subagentCaps?: ClaudeSubagentCaps;
  /** Native prompt suggestions after each turn (Phase 7). */
  readonly promptSuggestions?: boolean;
}

export interface ClaudeSubagentCaps {
  readonly maxSpawnDepth: number | null;
  readonly maxConcurrent: number | null;
}

/** Adds `CLAUDE_CODE_MAX_*` only for configured caps; otherwise returns the input unchanged. */
export function withClaudeSubagentCaps(
  environment: Readonly<Record<string, string | undefined>>,
  caps: ClaudeSubagentCaps | undefined,
): Readonly<Record<string, string | undefined>> {
  if (!caps || (caps.maxSpawnDepth === null && caps.maxConcurrent === null)) return environment;
  return {
    ...environment,
    ...(caps.maxSpawnDepth !== null
      ? { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: String(caps.maxSpawnDepth) }
      : {}),
    ...(caps.maxConcurrent !== null
      ? { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(caps.maxConcurrent) }
      : {}),
  };
}

/**
 * Claude Code resumes an interrupted turn on its own when this is set. bigbud decides that
 * itself after sleep (reconcile first, never replay), so a user's shell value must not reach
 * the CLI.
 */
const CLAUDE_RESUME_INTERRUPTED_TURN_ENV = "CLAUDE_CODE_RESUME_INTERRUPTED_TURN";

/** The environment without `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`; unchanged when it is absent. */
export function withoutClaudeInterruptedTurnResume(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  if (!(CLAUDE_RESUME_INTERRUPTED_TURN_ENV in environment)) return environment;
  const { [CLAUDE_RESUME_INTERRUPTED_TURN_ENV]: _removed, ...rest } = environment;
  return rest;
}

type ClaudeNativeEffort = NonNullable<ClaudeModelInfo["supportedEffortLevels"]>[number];

export function resolveClaudeRuntimeTraits(
  modelSelection: ProviderSessionStartInput["modelSelection"],
) {
  const selection = modelSelection?.provider === "claudeAgent" ? modelSelection : undefined;
  const caps = getClaudeModelCapabilities(selection?.model);
  const rawEffort = trimOrNull(selection?.options?.effort);
  const promptInjectedEffort =
    rawEffort !== null && caps.promptInjectedEffortLevels.includes(rawEffort);
  const resolvedEffort = promptInjectedEffort ? undefined : resolveEffort(caps, rawEffort);
  const effectiveEffort = (resolvedEffort ?? null) as ClaudeNativeEffort | null;
  const ultracode =
    selection?.options?.ultracode === true &&
    caps.workflowModes?.some((mode) => mode.value === "ultracode") === true;
  return {
    effectiveEffort: ultracode ? ("xhigh" satisfies ClaudeNativeEffort) : effectiveEffort,
    fastMode: selection?.options?.fastMode === true && caps.supportsFastMode,
    thinking:
      typeof selection?.options?.thinking === "boolean" && caps.supportsThinkingToggle
        ? selection.options.thinking
        : undefined,
    ultracode,
  };
}

export function buildClaudeQueryOptions(input: BuildClaudeQueryOptionsInput): {
  readonly apiModelId: string | undefined;
  readonly effectiveEffort: ClaudeNativeEffort | null;
  readonly fastMode: boolean;
  readonly thinking: boolean | undefined;
  readonly ultracode: boolean;
  readonly permissionMode: ReturnType<typeof resolveBasePermissionMode>;
  readonly queryOptions: ClaudeQueryOptions;
} {
  const modelSelection =
    input.input.modelSelection?.provider === "claudeAgent" ? input.input.modelSelection : undefined;
  const apiModelId = modelSelection ? resolveApiModelId(modelSelection) : undefined;
  const { effectiveEffort, fastMode, thinking, ultracode } =
    resolveClaudeRuntimeTraits(modelSelection);
  const permissionMode = resolveBasePermissionMode(input.input.runtimeMode);
  const settings = {
    ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
    ...(fastMode ? { fastMode: true } : {}),
    ...(ultracode ? { ultracode: true } : {}),
  };

  return {
    apiModelId,
    effectiveEffort,
    fastMode,
    thinking,
    ultracode,
    permissionMode,
    queryOptions: {
      ...(input.runtimeCwd ? { cwd: input.runtimeCwd } : {}),
      ...(apiModelId ? { model: apiModelId } : {}),
      pathToClaudeCodeExecutable: input.claudeBinaryPath,
      settingSources: [...(input.settingSources ?? CLAUDE_SETTING_SOURCES)],
      ...(effectiveEffort ? { effort: effectiveEffort } : {}),
      permissionMode,
      ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      ...(Object.keys(settings).length > 0 ? { settings } : {}),
      ...(input.existingResumeSessionId ? { resume: input.existingResumeSessionId } : {}),
      ...(input.existingResumeSessionId && input.resumeSessionAt
        ? { resumeSessionAt: input.resumeSessionAt }
        : {}),
      ...(input.newSessionId ? { sessionId: input.newSessionId } : {}),
      ...input.remoteQueryOptions,
      mcpServers: {
        ...input.remoteQueryOptions?.mcpServers,
        ...input.orchestrationConfig.mcpServers,
      },
      allowedTools: [
        ...(input.remoteQueryOptions?.allowedTools ?? []),
        ...input.orchestrationConfig.allowedTools,
      ],
      includePartialMessages: true,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: BIGBUD_CAPABILITY_CATALOG_PROTOCOL,
        excludeDynamicSections: true,
      },
      ...(input.boundedHookProgress
        ? { includeHookEvents: true, agentProgressSummaries: true }
        : {}),
      ...(input.forwardSubagentText ? { forwardSubagentText: true } : {}),
      ...(input.promptSuggestions ? { promptSuggestions: true } : {}),
      canUseTool: input.canUseTool,
      ...(input.onElicitation ? { onElicitation: input.onElicitation } : {}),
      env: withoutClaudeInterruptedTurnResume(
        withClaudeSubagentCaps(input.environment ?? process.env, input.subagentCaps),
      ),
      ...(input.runtimeCwd && !input.hasRemoteWorkspaceBridge
        ? { additionalDirectories: [input.runtimeCwd] }
        : {}),
    } as ClaudeQueryOptions,
  };
}
