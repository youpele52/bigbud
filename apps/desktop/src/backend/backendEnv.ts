import { backendChildEnv } from "../logging/logging";

export function withBackendNodeOptions(
  env: NodeJS.ProcessEnv,
  backendMaxOldSpaceMb: number | null,
): NodeJS.ProcessEnv {
  if (!backendMaxOldSpaceMb) return env;
  const nextFlag = `--max-old-space-size=${backendMaxOldSpaceMb}`;
  const existingNodeOptions = env.NODE_OPTIONS?.trim();
  if (existingNodeOptions?.includes("--max-old-space-size=")) return env;
  return {
    ...env,
    NODE_OPTIONS: existingNodeOptions ? `${existingNodeOptions} ${nextFlag}` : nextFlag,
  };
}

export function buildBackendChildEnvironment(input: {
  readonly packagedOpencodeBinDir: string | null;
  readonly packagedBundledSkillsDir: string | null;
  readonly packagedBundledAgentsDir: string | null;
  readonly packagedWorkspaceAgentBinary: string | null;
  readonly packagedDesktopSupervisorBinary: string | null;
  readonly computerUseRuntimeEnv: NodeJS.ProcessEnv;
  readonly backendNodeExecutable: string;
  readonly isPackaged: boolean;
  readonly backendMaxOldSpaceMb: number | null;
}): NodeJS.ProcessEnv {
  const environment = withBackendNodeOptions(
    {
      ...backendChildEnv(),
      ...(input.packagedOpencodeBinDir
        ? {
            PATH: [input.packagedOpencodeBinDir, process.env.PATH]
              .filter((entry): entry is string => Boolean(entry && entry.length > 0))
              .join(process.platform === "win32" ? ";" : ":"),
          }
        : {}),
      ...(input.packagedBundledSkillsDir
        ? { BIGBUD_BUNDLED_SKILLS_DIR: input.packagedBundledSkillsDir }
        : {}),
      ...(input.packagedBundledAgentsDir
        ? { BIGBUD_BUNDLED_AGENTS_DIR: input.packagedBundledAgentsDir }
        : {}),
      ...(input.packagedWorkspaceAgentBinary
        ? { BIGBUD_LOCAL_WORKSPACE_AGENT_BINARY: input.packagedWorkspaceAgentBinary }
        : {}),
      ...(input.packagedDesktopSupervisorBinary
        ? { BIGBUD_DESKTOP_SUPERVISOR_BINARY: input.packagedDesktopSupervisorBinary }
        : {}),
      ...input.computerUseRuntimeEnv,
      BIGBUD_NODE_EXECUTABLE: input.backendNodeExecutable,
      BIGBUD_DESKTOP_PACKAGED: input.isPackaged ? "1" : "0",
      ELECTRON_RUN_AS_NODE: "1",
      BIGBUD_STARTUP_STATUS_FD: "4",
    },
    input.backendMaxOldSpaceMb,
  );
  delete environment.BIGBUD_SYSTEM_MONITOR_AGENT_ENDPOINT;
  delete environment.BIGBUD_SYSTEM_MONITOR_AGENT_TOKEN;
  return environment;
}
