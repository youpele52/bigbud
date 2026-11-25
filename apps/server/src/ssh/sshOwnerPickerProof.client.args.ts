import type { PickerProofOwnerOptions } from "./sshOwnerPickerProof.client.types.ts";

/**
 * Builds the only argv a picker/production owner may receive. Fixture modes keep
 * their current order; production mode accepts only profile, state directory
 * and fixed facts.
 *
 * @module sshOwnerPickerProof.client.args
 */

export interface PickerProofProviderFixtureFacts {
  readonly binaryPath: string;
  readonly sha256: string;
  readonly cwd: string;
  readonly threadId: string;
  readonly sessionEpoch: number;
}

export interface PickerProofRelayFixtureFacts {
  readonly nodeBinary: string;
  readonly nodeSha256: string;
  readonly helperEntry: string;
  readonly helperSha256: string;
  readonly authorityId: string;
}

export interface PickerProofArgFacts {
  readonly profileBindingHex: string;
  readonly attachmentSocket?: string;
  readonly aliasArgs: ReadonlyArray<string>;
  readonly agentFixture?: { readonly binaryPath: string; readonly sha256: string };
  readonly installedAgentState?: string;
  readonly identityAgentPath?: string;
  readonly provider?: PickerProofProviderFixtureFacts & { readonly codex: boolean };
  readonly opencode?: PickerProofProviderFixtureFacts;
  readonly relay?: PickerProofRelayFixtureFacts;
  readonly scopedArgs: ReadonlyArray<string>;
}

export function pickerProofLaunchArgs(
  options: PickerProofOwnerOptions,
  facts: PickerProofArgFacts,
): ReadonlyArray<string> {
  const production = options.productionLaunch;
  const attach = facts.attachmentSocket ? ["--attach-socket", facts.attachmentSocket] : [];
  const workspace =
    options.workspaceRoot === undefined ? [] : ["--workspace-root", options.workspaceRoot];
  if (production) {
    return [
      "--production",
      "--profile",
      production.profileBindingText,
      "--state-dir",
      production.stateDirectory,
      options.targetId,
      options.sshBinary,
      options.keyscanBinary,
      options.host,
      String(options.port),
      options.user,
      options.identityFile,
      options.knownHostsFile,
      ...attach,
      ...workspace,
    ];
  }
  const provider = facts.provider;
  const opencode = facts.opencode;
  const relay = facts.relay;
  return [
    facts.profileBindingHex,
    options.targetId,
    options.lockFile,
    options.sshBinary,
    options.keyscanBinary,
    options.host,
    String(options.port),
    options.user,
    options.identityFile,
    options.knownHostsFile,
    ...facts.aliasArgs,
    ...attach,
    ...workspace,
    ...(options.devInteractiveTerminal ? ["--dev-interactive-terminal"] : []),
    ...(facts.agentFixture
      ? [
          "--agent-fixture",
          facts.agentFixture.binaryPath,
          "--agent-sha256",
          facts.agentFixture.sha256,
        ]
      : []),
    ...(facts.installedAgentState === undefined
      ? []
      : ["--installed-agent-state", facts.installedAgentState]),
    ...(options.providerService
      ? ["--provider-service", options.providerService.kind, options.providerService.binaryPath]
      : []),
    ...(options.opencodeService ? ["--opencode-service", options.opencodeService.binaryPath] : []),
    ...(provider
      ? [
          provider.codex ? "--codex-fixture" : "--pi-fixture",
          provider.binaryPath,
          provider.sha256,
          provider.cwd,
          provider.threadId,
          String(provider.sessionEpoch),
        ]
      : []),
    ...(facts.identityAgentPath ? ["--identity-agent-path", facts.identityAgentPath] : []),
    ...facts.scopedArgs,
    ...(opencode
      ? [
          "--opencode-v1-fixture",
          opencode.binaryPath,
          opencode.sha256,
          opencode.cwd,
          opencode.threadId,
          String(opencode.sessionEpoch),
        ]
      : []),
    ...(relay
      ? [
          "--client-relay-fixture",
          relay.nodeBinary,
          relay.nodeSha256,
          relay.helperEntry,
          relay.helperSha256,
          relay.authorityId,
        ]
      : []),
  ];
}
