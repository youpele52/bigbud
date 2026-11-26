import * as Effect from "effect/Effect";

import {
  readSshOwnerProductionOwner,
  type SshOwnerProductionRegistration,
} from "../../../ssh/sshOwnerProductionRegistry.ts";
import { isTrustedRemoteExecutablePath } from "../../../ssh/sshOwnerRemotePath.ts";
import type { PickerProofOpencodeV2Lane } from "../../../ssh/sshOwnerPickerProof.client.providerPorts.ts";
import type { LaunchedPickerProofOwner } from "../../../ssh/sshOwnerPickerProof.client.types.ts";
import type { DevOpencodeV2ServiceRefusal } from "../../../ssh/sshOwnerDevRuntime.providerServices.ts";
import type { V2SshOwner } from "./ServerManager.sshOwner.ts";

/**
 * Owner-session facts for the OpenCode v2 SSH composition.
 *
 * This module is import-safe for the production V2 graph: it never imports the
 * private launcher, the SSH factory or a child-process module. The graph holds
 * this source, and only a remote acquisition dynamically loads the launcher.
 *
 * @module ServerManager.ownerV2.source
 */

export type V2OwnerRefusalReason =
  | "no-binding"
  | "non-absolute-path"
  | "settings-unreadable"
  | "platform"
  | "workspace"
  | "owner-unavailable";

/** A typed refusal; each reason names one missing precondition. */
export class SelectedV2OwnerError extends Error {
  constructor(
    readonly reason: V2OwnerRefusalReason,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "SelectedV2OwnerError";
  }
}

export type V2OwnerServiceBinding =
  | { readonly kind: "bound"; readonly binaryPath: string }
  | {
      readonly kind: "refused";
      readonly reason: Extract<
        V2OwnerRefusalReason,
        "no-binding" | "non-absolute-path" | "settings-unreadable"
      >;
    };

/**
 * The profile setting is only trusted under the shared remote-executable rule
 * (absolute, normalized POSIX, unpadded, no NUL); anything else keeps v2
 * refused with its own reason.
 */
export function resolveV2OwnerServiceBinding(
  value: unknown,
  refusal?: DevOpencodeV2ServiceRefusal,
): V2OwnerServiceBinding {
  if (typeof value !== "string") return { kind: "refused", reason: refusal ?? "no-binding" };
  if (!isTrustedRemoteExecutablePath(value))
    return { kind: "refused", reason: "non-absolute-path" };
  return { kind: "bound", binaryPath: value };
}

export interface V2OwnerTargetSession {
  readonly targetId: string;
  /** Absent when the selected owner exists but has no v2 port bound. */
  readonly owner: V2SshOwner | undefined;
  /** Raw owner lane; the launcher builds the transport from it on demand. */
  readonly lane?: PickerProofOpencodeV2Lane;
  /** Trusted executable the selected owner was configured with, if any. */
  readonly serviceBinding: unknown;
  /** Settings-level refusal when the profile carries no usable binding. */
  readonly bindingRefusal?: DevOpencodeV2ServiceRefusal;
}

/** A selected owner session per exact target; never a caller-supplied program. */
export interface V2OwnerSessionSource {
  readonly target: (targetId: string) => Promise<V2OwnerTargetSession | undefined>;
}

/**
 * The typed OpenCode v2 facts a launched owner carries. Renaming any of them on
 * `LaunchedPickerProofOwner` fails typecheck here instead of silently refusing.
 */
export type V2LaunchFacts = Pick<
  LaunchedPickerProofOwner,
  "opencodeV2Lane" | "opencodeV2Service" | "opencodeV2Refusal"
>;

/**
 * Production source: reads the live registered owner on every acquisition, so
 * an owner that opens later is used and a dead owner is never served. The
 * launcher-bearing binder is loaded only when a live owner exists.
 */
export function makeRegisteredProductionV2OwnerSource(
  read: () => SshOwnerProductionRegistration | undefined,
): V2OwnerSessionSource {
  return {
    async target(targetId) {
      const live = read();
      if (!live) return undefined;
      const { makeProductionV2OwnerSource } = await import("./ServerManager.ownerV2.selected.ts");
      return makeProductionV2OwnerSource(live.handle, live.descriptorFor).target(targetId);
    },
  };
}

export interface ResolveSelectedV2OwnerSourceOptions {
  /** Test-only override of the live production owner registry. */
  readonly production?: () => SshOwnerProductionRegistration | undefined;
}

/**
 * Resolves the owner source: the live production owner, read on every
 * acquisition. Without a live owner every target stays a typed
 * `owner-unavailable` refusal.
 */
export const resolveSelectedV2OwnerSource = (
  options: ResolveSelectedV2OwnerSourceOptions = {},
): Effect.Effect<V2OwnerSessionSource> =>
  Effect.sync(() =>
    makeRegisteredProductionV2OwnerSource(options.production ?? readSshOwnerProductionOwner),
  );
