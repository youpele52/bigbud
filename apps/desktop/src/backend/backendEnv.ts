import { desktopMobileGatewayEnvironment } from "./mobileGatewayOwner";
import {
  resolveDesktopSshOwnerDevProfile,
  resolveDesktopSshOwnerProductionBinary,
} from "./backendEnv.sshOwner";
import { backendChildEnv } from "../logging/logging";
import { DEV_SSH_OWNER_WINDOWS_FIXTURE_ENV } from "@bigbud/shared/DevLauncher";

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
  /** packaged `ssh-owner/bin` locator; the server verifies the artifact itself. */
  readonly packagedSshOwnerBinary?: string | null;
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
      ...desktopMobileGatewayEnvironment(),
      BIGBUD_NODE_EXECUTABLE: input.backendNodeExecutable,
      BIGBUD_DESKTOP_PACKAGED: input.isPackaged ? "1" : "0",
      ELECTRON_RUN_AS_NODE: "1",
      BIGBUD_STARTUP_STATUS_FD: "4",
    },
    input.backendMaxOldSpaceMb,
  );
  if (!resolveDesktopSshOwnerDevProfile(input.isPackaged, environment)) {
    if (!input.isPackaged && process.platform === "win32" && environment.BIGBUD_SSH_OWNER === "1") {
      throw new Error("Invalid Windows Rust SSH owner dev profile. No legacy backend was started.");
    }
    const productionBinary = resolveDesktopSshOwnerProductionBinary({
      isPackaged: input.isPackaged,
      packagedBinary: input.packagedSshOwnerBinary ?? null,
    });
    delete environment.BIGBUD_SSH_OWNER;
    delete environment.BIGBUD_SSH_OWNER_NORMAL_DEV_READY;
    delete environment.BIGBUD_SSH_OWNER_NORMAL_DEV_PROFILE;
    if (productionBinary) environment.BIGBUD_SSH_OWNER_BIN = productionBinary;
    else delete environment.BIGBUD_SSH_OWNER_BIN;
  }
  delete environment[DEV_SSH_OWNER_WINDOWS_FIXTURE_ENV];
  delete environment.BIGBUD_SYSTEM_MONITOR_AGENT_ENDPOINT;
  delete environment.BIGBUD_SYSTEM_MONITOR_AGENT_TOKEN;
  return environment;
}
