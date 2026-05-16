import type { SessionConfig, SessionFsConfig, Tool, ToolResultObject } from "@github/copilot-sdk";

import { createRemoteWorkspaceSessionFsBridge } from "../../../remote-workspace-bridge/remoteWorkspaceSessionFsBridge.ts";
import {
  runToolCommand,
  resolveToolTransportTarget,
} from "../../../tool-transport/toolTransport.ts";
import type { WorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";

const COPILOT_REMOTE_WORKSPACE_EXCLUDED_TOOLS = [
  "powershell",
  "list_bash",
  "list_powershell",
  "read_bash",
  "read_powershell",
  "write_bash",
  "write_powershell",
  "stop_bash",
  "stop_powershell",
] as const;

const MAX_REMOTE_BASH_OUTPUT_CHARS = 64 * 1024;

function truncateOutput(text: string, maxChars: number): string {
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n\n[output truncated after ${maxChars} characters]`
    : text;
}

function normalizeRemoteCommandResult(output: string, exitCode: number): ToolResultObject {
  const trimmed = output.trim();
  const textResultForLlm =
    trimmed.length > 0
      ? truncateOutput(trimmed, MAX_REMOTE_BASH_OUTPUT_CHARS)
      : exitCode === 0
        ? "[command completed with no output]"
        : `[command failed with exit code ${exitCode}]`;
  return {
    textResultForLlm,
    resultType: exitCode === 0 ? "success" : "failure",
    ...(exitCode === 0 ? {} : { error: textResultForLlm }),
    sessionLog: textResultForLlm,
    toolTelemetry: { exitCode },
  };
}

function createRemoteBashTool(workspaceTarget: WorkspaceTarget): Tool<{ command: string }> {
  const transportTarget = resolveToolTransportTarget(workspaceTarget);
  return {
    name: "bash",
    description: "Run a shell command in the remote workspace over SSH.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute remotely" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    overridesBuiltInTool: true,
    handler: async ({ command }) => {
      const result = await runToolCommand({
        target: transportTarget,
        command: "sh",
        args: ["-lc", command],
        allowNonZeroExit: true,
        timeoutMs: 60_000,
        outputMode: "truncate",
      });
      return normalizeRemoteCommandResult(
        `${result.stdout}${result.stderr}`.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
        result.code ?? 0,
      );
    },
  };
}

export interface CopilotRemoteWorkspaceBridge {
  readonly runtimeCwd: string;
  readonly cleanup: () => Promise<void>;
  readonly clientSessionFsConfig: SessionFsConfig;
  readonly sessionConfig: Pick<
    SessionConfig,
    "createSessionFsHandler" | "excludedTools" | "systemMessage" | "tools"
  >;
}

export async function createCopilotRemoteWorkspaceBridge(
  workspaceTarget: WorkspaceTarget,
): Promise<CopilotRemoteWorkspaceBridge> {
  const bridge = await createRemoteWorkspaceSessionFsBridge(
    workspaceTarget,
    "bigbud-copilot-remote-workspace-",
    [
      "This directory is a synthetic local workspace used to run GitHub Copilot against a remote workspace.",
      "The actual project files live on the remote host configured for this thread.",
      "",
    ],
  );

  return {
    runtimeCwd: bridge.cwd,
    cleanup: bridge.cleanup,
    clientSessionFsConfig: bridge.sessionFsConfig,
    sessionConfig: {
      createSessionFsHandler: () => bridge.createSessionFsHandler(),
      excludedTools: [...COPILOT_REMOTE_WORKSPACE_EXCLUDED_TOOLS],
      tools: [createRemoteBashTool(workspaceTarget)],
      systemMessage: {
        mode: "append",
        content: [
          "Bigbud remote workspace mode is enabled.",
          `The working directory for repository work is ${bridge.initialCwd} on the remote host ${bridge.destination}.`,
          "Use the normal file and edit tools; they are backed by the remote workspace session filesystem.",
          "Use the bash tool for shell commands in the remote workspace.",
          "Do not rely on local filesystem or local shell context for repository work in this session.",
        ].join(" "),
      },
    },
  };
}
