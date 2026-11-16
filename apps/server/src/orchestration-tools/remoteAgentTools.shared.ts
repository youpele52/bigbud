/**
 * Phase 5 agent capability: request remote-agent status or installation through the same
 * operation as the app and `bigbud remote-agent`. Agents authenticate with their per-thread tool
 * credential, never the CLI socket, and cannot grant consent: an unapproved host returns
 * `consent-required` for the user to approve. Only the Rust base agent is installed; backend
 * runtime and vendor tools need their own explicit setup.
 */
export const REMOTE_AGENT_TOOL_NAMES = ["remote_agent_status", "remote_agent_install"] as const;
export type RemoteAgentToolName = (typeof REMOTE_AGENT_TOOL_NAMES)[number];

export function isRemoteAgentToolName(value: unknown): value is RemoteAgentToolName {
  return (REMOTE_AGENT_TOOL_NAMES as ReadonlyArray<unknown>).includes(value);
}

export const REMOTE_AGENT_STATUS_TOOL_DESCRIPTION =
  "Read the bigbud remote agent status of a saved remote target (target ID or SSH alias such as user@host). Read-only.";
export const REMOTE_AGENT_INSTALL_TOOL_DESCRIPTION =
  "Install or replace the bigbud remote agent on a saved bigbud remote target and activate it. Returns an operation: when state is running, call again with the same operationId to follow it; never start a second install. Hosts that are not saved in bigbud are refused; ask the user to add the host in bigbud or run `bigbud remote-agent install <host>` themselves. Installs only the base agent, never provider tools.";

const TARGET = { type: "string", minLength: 1, maxLength: 512 };

export const REMOTE_AGENT_STATUS_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["target"],
  properties: { target: TARGET },
};

export const REMOTE_AGENT_INSTALL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: [],
  properties: {
    target: TARGET,
    replace: { type: "boolean" },
    operationId: { type: "string", pattern: "^[0-9a-f-]{36}$" },
  },
};

export const REMOTE_AGENT_TOOL_SPECS = [
  {
    name: "remote_agent_status",
    description: REMOTE_AGENT_STATUS_TOOL_DESCRIPTION,
    parameters: REMOTE_AGENT_STATUS_PARAMETERS,
  },
  {
    name: "remote_agent_install",
    description: REMOTE_AGENT_INSTALL_TOOL_DESCRIPTION,
    parameters: REMOTE_AGENT_INSTALL_PARAMETERS,
  },
] as const;

export interface RemoteAgentToolInput {
  readonly tool: RemoteAgentToolName;
  readonly arguments: unknown;
}
