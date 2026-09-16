import {
  makeRemoteAgentComposition,
  type RemoteAgentComposition,
} from "./remoteAgentComposition.ts";
import { parseSshExecutionTarget, parseSshExecutionTransport } from "../ssh/sshExecutionTarget.ts";

export const DEFAULT_REMOTE_AGENT_BINARY = "$HOME/.bigbud/agent/bin/current";

export type RemoteAgentTransport = "agent" | "direct-ssh";

export interface RemoteAgentConfiguration {
  readonly transport: RemoteAgentTransport;
  readonly binaryPath: string | null;
}

const compositions = new Map<string, RemoteAgentComposition>();

export function resolveRemoteAgentConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): RemoteAgentConfiguration {
  const requestedTransport = environment.BIGBUD_REMOTE_AGENT_TRANSPORT?.trim();
  if (requestedTransport && requestedTransport !== "agent" && requestedTransport !== "direct-ssh") {
    throw new Error("BIGBUD_REMOTE_AGENT_TRANSPORT must be either 'agent' or 'direct-ssh'.");
  }
  if (requestedTransport === "direct-ssh") {
    return {
      transport: "direct-ssh",
      // The process default controls legacy target IDs only. Agent projects
      // remain available in the same server so users can choose per project.
      binaryPath: environment.BIGBUD_REMOTE_AGENT_BINARY?.trim() || DEFAULT_REMOTE_AGENT_BINARY,
    };
  }
  return {
    transport: "agent",
    binaryPath: environment.BIGBUD_REMOTE_AGENT_BINARY?.trim() || DEFAULT_REMOTE_AGENT_BINARY,
  };
}

/** Resolve a project transport while retaining the process setting for legacy target IDs. */
export function resolveRemoteAgentTransport(
  executionTargetId: string | null | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): RemoteAgentTransport {
  return (
    parseSshExecutionTransport(executionTargetId) ??
    resolveRemoteAgentConfiguration(environment).transport
  );
}

export function isRemoteAgentExecutionTarget(
  executionTargetId: string | null | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    parseSshExecutionTarget(executionTargetId) !== null &&
    resolveRemoteAgentTransport(executionTargetId, environment) === "agent"
  );
}

export function getConfiguredRemoteAgentComposition(): RemoteAgentComposition | null {
  const configuration = resolveRemoteAgentConfiguration();
  if (!configuration.binaryPath) return null;
  const existing = compositions.get(configuration.binaryPath);
  if (existing) return existing;
  const composition = makeRemoteAgentComposition({ binaryPath: configuration.binaryPath });
  compositions.set(configuration.binaryPath, composition);
  return composition;
}

export function closeConfiguredRemoteAgentCompositions(): void {
  for (const composition of compositions.values()) composition.pool.closeAll();
  compositions.clear();
}
