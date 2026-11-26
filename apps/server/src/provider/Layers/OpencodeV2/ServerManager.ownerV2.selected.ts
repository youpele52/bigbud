import type { SshOwnerProductionHandle } from "../../../ssh/sshOwnerProductionClient.ts";
import type { SshOwnerTargetDescriptor } from "../../../ssh/sshOwnerProductionClient.launch.ts";
import { descriptorServesTarget } from "../../../ssh/sshOwnerProductionTargets.ts";
import { startOwnedV2Process } from "./ServerManager.child.ts";
import { makeV2SshOwner } from "./ServerManager.sshOwner.ts";
import {
  resolveV2OwnerServiceBinding,
  SelectedV2OwnerError,
  type V2OwnerRefusalReason,
  type V2OwnerSessionSource,
  type V2OwnerTargetSession,
} from "./ServerManager.ownerV2.source.ts";
import type { OwnedV2Process, V2ProcessConfig } from "./ServerManager.types.ts";

export * from "./ServerManager.ownerV2.source.ts";

/**
 * Selected/production OpenCode v2 SSH owner composition.
 *
 * The owner selects the executable, `serve` argv, remote port, local listener,
 * forward spec and per-lease credential. This module only hands the exact
 * target/workspace/cwd to that owner through the existing `V2SshOwner` seam.
 *
 * A remote target never falls back to the shared local service: without an
 * owner and an absolute binding it stays typed-refused.
 *
 * This module statically reaches the private launcher, so the production graph
 * loads it lazily and only for a remote acquisition.
 *
 * @module ServerManager.ownerV2.selected
 */

export interface StartSelectedV2OwnerProcessOptions {
  /** Test-only platform override; production always uses the host platform. */
  readonly platform?: NodeJS.Platform;
}

function refusal(reason: V2OwnerRefusalReason, detail: string, cause?: unknown) {
  return new SelectedV2OwnerError(
    reason,
    `OpenCode v2 SSH owner refused: ${detail}`,
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Acquires one remote v2 server through the selected owner. Readiness and
 * teardown stay owner-confirmed: `startOwnedV2Process` only returns after the
 * owner publishes its listener and credential, and closes only after the owner
 * acknowledges teardown for this lease.
 */
export async function startSelectedV2OwnerProcess(
  config: V2ProcessConfig,
  source: V2OwnerSessionSource | undefined,
  options: StartSelectedV2OwnerProcessOptions = {},
): Promise<OwnedV2Process> {
  if (config.sharedService !== undefined)
    throw refusal(
      "owner-unavailable",
      "the selected composition never borrows the shared local service for a v2 owner target.",
    );
  const platform = options.platform ?? process.platform;
  if (platform !== "linux")
    throw refusal(
      "platform",
      `the native owner has no OpenCode v2 lane on ${platform}; the remote target was not borrowed locally.`,
    );
  if (config.runtimeTargetId === "local")
    throw refusal("platform", "the owner lane serves remote targets only.");
  if (!config.workspaceRoot)
    throw refusal(
      "workspace",
      "the remote target has no authorized workspace root for the v2 owner lease.",
    );
  if (!source)
    throw refusal(
      "owner-unavailable",
      "no SSH owner is selected or active for this composition; the remote target was not borrowed locally.",
    );
  let target: V2OwnerTargetSession | undefined;
  try {
    target = await source.target(config.runtimeTargetId);
  } catch (cause) {
    throw refusal(
      "owner-unavailable",
      "the selected owner session could not bind this exact target.",
      cause,
    );
  }
  if (!target || target.targetId !== config.runtimeTargetId)
    throw refusal(
      "owner-unavailable",
      "the selected owner has no OpenCode v2 session for this exact target.",
    );
  const binding = resolveV2OwnerServiceBinding(target.serviceBinding, target.bindingRefusal);
  if (binding.kind === "refused")
    throw refusal(
      binding.reason,
      binding.reason === "no-binding"
        ? "the selected owner has no configured OpenCode v2 executable."
        : binding.reason === "settings-unreadable"
          ? "the selected owner's profile settings could not be read or parsed."
          : "the configured OpenCode v2 executable is not an absolute POSIX path.",
    );
  const owner =
    target.owner ??
    (target.lane &&
      makeV2SshOwner(
        target.lane.client,
        target.lane.targetId,
        target.lane.binding,
        target.lane.binaryPath,
      ));
  if (!owner)
    throw refusal(
      "owner-unavailable",
      "the selected owner has no OpenCode v2 session for this exact target.",
    );
  return startOwnedV2Process(
    // The executable always comes from the trusted profile binding, never from
    // the request. The owner request therefore carries only target, workspace
    // and cwd.
    { ...config, binaryPath: binding.binaryPath },
    undefined,
    owner,
  );
}

/**
 * Production sibling: binds the verified owner handle's per-target client. The
 * caller supplies the exact resolved descriptor; no request can name a program.
 */
export function makeProductionV2OwnerSource(
  handle: Pick<SshOwnerProductionHandle, "target" | "ownerEpoch" | "opencodeV2Service">,
  descriptorFor: (targetId: string) => Promise<SshOwnerTargetDescriptor>,
): V2OwnerSessionSource {
  const binding = handle.opencodeV2Service?.binaryPath;
  return {
    async target(targetId) {
      // A resolver refusal propagates as the typed cause of `owner-unavailable`.
      const descriptor = await descriptorFor(targetId);
      if (!descriptorServesTarget(descriptor, targetId)) return undefined;
      // The owner is live but launched without a v2 binding: typed `no-binding`.
      if (binding === undefined) return { targetId, owner: undefined, serviceBinding: undefined };
      const bound = handle.target(descriptor);
      return {
        targetId,
        owner: makeV2SshOwner(
          bound,
          targetId,
          () => ({
            ownerEpoch: handle.ownerEpoch,
            targetGeneration: bound.generation,
          }),
          binding,
        ),
        serviceBinding: binding,
      };
    },
  };
}
