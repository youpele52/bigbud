import type { PickerProofOwnerOptions } from "./sshOwnerPickerProof.client.types.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

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

export interface PickerProofTargetFacts {
  readonly targetId: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly identityFile: string;
  readonly knownHostsFile: string;
}

export interface PickerProofArgFacts {
  readonly profileBindingHex: string;
  /** Pinned fixture target facts; absent in production mode. */
  readonly target?: PickerProofTargetFacts;
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
    // No target, host, port, user, identity or known-hosts argument: one owner
    // serves every target from its request descriptors.
    return [
      "--production",
      "--profile",
      production.profileBindingText,
      "--state-dir",
      production.stateDirectory,
      "--ssh",
      options.sshBinary,
      "--keyscan",
      options.keyscanBinary,
      ...attach,
      ...workspace,
      // Owner-selected provider bindings. A request never supplies these.
      ...(options.agentService
        ? [
            "--agent-binary",
            options.agentService.binaryPath,
            "--agent-sha256",
            options.agentService.sha256,
            "--agent-state",
            options.agentService.stateDir,
          ]
        : []),
      ...(options.opencodeService
        ? ["--opencode-service", options.opencodeService.binaryPath]
        : []),
      ...(options.opencodeV2Service
        ? ["--opencode-v2-service", options.opencodeV2Service.binaryPath]
        : []),
    ];
  }
  const target = facts.target;
  if (!target) throw new PickerProofOwnerError("invalidOperands");
  const provider = facts.provider;
  const opencode = facts.opencode;
  const relay = facts.relay;
  return [
    facts.profileBindingHex,
    target.targetId,
    options.lockFile,
    options.sshBinary,
    options.keyscanBinary,
    target.host,
    String(target.port),
    target.user,
    target.identityFile,
    target.knownHostsFile,
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
    ...(options.opencodeV2Service
      ? ["--opencode-v2-service", options.opencodeV2Service.binaryPath]
      : []),
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
