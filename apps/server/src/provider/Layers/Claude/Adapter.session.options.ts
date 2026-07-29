import type { OnElicitation, Options as ClaudeQueryOptions } from "@anthropic-ai/claude-agent-sdk";
import { type ClaudeCodeEffort, type ProviderSessionStartInput } from "@bigbud/contracts";
import { resolveApiModelId, resolveEffort } from "@bigbud/shared/model";

import { getClaudeModelCapabilities } from "./Provider.ts";
import { getEffectiveClaudeCodeEffort, CLAUDE_SETTING_SOURCES } from "./Adapter.utils.ts";
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
}

export function buildClaudeQueryOptions(input: BuildClaudeQueryOptionsInput): {
  readonly apiModelId: string | undefined;
  readonly effectiveEffort: ClaudeCodeEffort | null;
  readonly fastMode: boolean;
  readonly permissionMode: ReturnType<typeof resolveBasePermissionMode>;
  readonly queryOptions: ClaudeQueryOptions;
} {
  const modelSelection =
    input.input.modelSelection?.provider === "claudeAgent" ? input.input.modelSelection : undefined;
  const caps = getClaudeModelCapabilities(modelSelection?.model);
  const apiModelId = modelSelection ? resolveApiModelId(modelSelection) : undefined;
  const effort = (resolveEffort(caps, modelSelection?.options?.effort) ??
    null) as ClaudeCodeEffort | null;
  const fastMode = modelSelection?.options?.fastMode === true && caps.supportsFastMode;
  const thinking =
    typeof modelSelection?.options?.thinking === "boolean" && caps.supportsThinkingToggle
      ? modelSelection.options.thinking
      : undefined;
  const effectiveEffort = getEffectiveClaudeCodeEffort(effort);
  const permissionMode = resolveBasePermissionMode(input.input.runtimeMode);
  const settings = {
    ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
    ...(fastMode ? { fastMode: true } : {}),
  };

  return {
    apiModelId,
    effectiveEffort,
    fastMode,
    permissionMode,
    queryOptions: {
      ...(input.runtimeCwd ? { cwd: input.runtimeCwd } : {}),
      ...(apiModelId ? { model: apiModelId } : {}),
      pathToClaudeCodeExecutable: input.claudeBinaryPath,
      settingSources: [...(input.settingSources ?? CLAUDE_SETTING_SOURCES)],
      ...(effectiveEffort ? { effort: effectiveEffort } : {}),
      ...(permissionMode ? { permissionMode } : {}),
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
      canUseTool: input.canUseTool,
      ...(input.onElicitation ? { onElicitation: input.onElicitation } : {}),
      env: input.environment ?? process.env,
      ...(input.runtimeCwd && !input.hasRemoteWorkspaceBridge
        ? { additionalDirectories: [input.runtimeCwd] }
        : {}),
    } as ClaudeQueryOptions,
  };
}
