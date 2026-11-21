import { createHash } from "node:crypto";
import * as Schema from "effect/Schema";
import { TerminalWslIdentity } from "@bigbud/contracts/workspace/terminal.wsl.ts";
import { parseSshExecutionTarget } from "../../ssh/sshExecutionTarget";
import { sameShellHost } from "./ShellProfiles.launch";
import {
  ExecutionHostShellLaunch,
  parseExecutionHostShellLaunch,
} from "./ShellProfiles.launch.metadata";
import { remoteShellHost } from "./ShellProfiles.remote.identity";

import type { HostedDirectShellOwnerStore } from "./DirectShellLaunch.hosted";
import {
  DirectShellLifecycleBinding,
  directShellLifecycleDigestFields,
  type DirectShellLifecycleControl,
} from "./DirectShellLaunch.lifecycle";

const Token = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,128}$/));
export const DirectShellLaunchIntent = Schema.Struct({
  executionTargetId: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(4096)),
  wslIdentity: Schema.optionalKey(TerminalWslIdentity),
  launch: ExecutionHostShellLaunch,
  lifecycle: Schema.optionalKey(DirectShellLifecycleBinding),
});
export type DirectShellLaunchIntent = typeof DirectShellLaunchIntent.Type;

const PaneId = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(4096));
const Owner = Schema.Struct({
  version: Schema.Literal(1),
  pane: Schema.optionalKey(Schema.Struct({ threadId: PaneId, terminalId: PaneId })),
  ownerKey: Schema.String.check(Schema.isPattern(/^terminal:[a-f0-9]{64}$/)),
  reservationId: Token,
  controllerId: Token,
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  intent: DirectShellLaunchIntent,
  state: Schema.Literals(["prepared", "may-have-been-sent", "outcome-unknown"]),
});
export type DirectShellLaunchOwner = typeof Owner.Type;

export function directShellOwnerKey(threadId: string, terminalId: string): string {
  if (!threadId || !terminalId) throw new Error("A direct shell owner requires a pane identity.");
  return `terminal:${createHash("sha256")
    .update(JSON.stringify([threadId, terminalId]))
    .digest("hex")}`;
}

/** Canonical, requested intent only. No environment, shell buffer or history is persisted. */
export function directShellLaunchDigest(input: DirectShellLaunchIntent): string {
  const intent = Schema.decodeUnknownSync(DirectShellLaunchIntent)(input);
  const launch = parseExecutionHostShellLaunch(intent.launch);
  const host = remoteShellHost(intent);
  if (!sameShellHost(host, launch.requestedProfile.host))
    throw new Error("Direct shell launch host does not match its execution target.");
  if (
    host.kind === "ssh" &&
    parseSshExecutionTarget(intent.executionTargetId)?.transport === "agent"
  )
    throw new Error("An agent execution target cannot reserve a direct shell launch.");
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: intent.lifecycle ? 2 : 1,
        ...(intent.lifecycle
          ? { lifecycle: directShellLifecycleDigestFields(intent.lifecycle) }
          : {}),
        executionTargetId: intent.executionTargetId,
        wslIdentity: intent.wslIdentity
          ? [intent.wslIdentity.distribution, intent.wslIdentity.username, intent.wslIdentity.uid]
          : null,
        cwd: launch.cwd,
        host,
        profileId: launch.requestedProfile.profileId,
        kind: launch.requestedProfile.kind,
        executable: launch.executable,
        args: launch.args,
        platform: launch.platform,
        integration: launch.integration,
      }),
    )
    .digest("hex");
}

export function parseDirectShellLaunchOwner(input: unknown): DirectShellLaunchOwner {
  const owner = Schema.decodeUnknownSync(Owner)(input);
  if (Buffer.byteLength(JSON.stringify(owner)) > 16 * 1024)
    throw new Error("Direct shell owner is too large.");
  if (
    owner.pane &&
    directShellOwnerKey(owner.pane.threadId, owner.pane.terminalId) !== owner.ownerKey
  )
    throw new Error("Direct shell owner pane identity conflict.");
  if (owner.digest !== directShellLaunchDigest(owner.intent))
    throw new Error("Direct shell owner intent does not match its digest.");
  return structuredClone(owner);
}

/**
 * The legacy members below read and write version 1 owners only; Direct SSH panes in the local
 * terminal host (M7) use the optional hosted members, which legacy and test stores may omit.
 */
export interface DirectShellLaunchOwnerStore extends Partial<HostedDirectShellOwnerStore> {
  /**
   * Pane-scoped owners match by their validated pane. Legacy owners without pane metadata are
   * never assigned to a thread by guesswork: they match only when `isThreadPaneKey` recognises
   * their key as one of this thread's known panes. Omitting it keeps the conservative default
   * (every legacy owner blocks every thread).
   */
  readonly hasOwnersForThread?: (
    threadId: string,
    isThreadPaneKey?: (ownerKey: string) => boolean,
  ) => Promise<boolean>;
  /** The owners `hasOwnersForThread` would match, for an explicit user decision. */
  readonly listForThread?: (
    threadId: string,
    isThreadPaneKey: (ownerKey: string) => boolean,
  ) => Promise<ReadonlyArray<DirectShellLaunchOwner>>;
  /**
   * Explicit user recovery only: forgets exactly the owners `listForThread` returns (unchanged
   * since they were read), never another thread's. The remote shell is not stopped.
   */
  readonly forgetForThread?: (
    threadId: string,
    isThreadPaneKey: (ownerKey: string) => boolean,
  ) => Promise<number>;
  readonly get: (ownerKey: string) => Promise<DirectShellLaunchOwner | undefined>;
  readonly reserve: (owner: DirectShellLaunchOwner) => Promise<{
    readonly created: boolean;
    readonly owner: DirectShellLaunchOwner;
  }>;
  /** A successful durable transition is a one-shot dispatch permit, not exec evidence. */
  readonly claimDispatch: (
    ownerKey: string,
    reservationId: string,
    controllerId: string,
  ) => Promise<boolean>;
  readonly cancelPrepared: (
    ownerKey: string,
    reservationId: string,
    controllerId: string,
  ) => Promise<boolean>;
  readonly markUnknown: (
    ownerKey: string,
    reservationId: string,
    controllerId: string,
  ) => Promise<boolean>;
  /** Explicit recovery only. Legacy owners without a pre-dispatch binding cannot be released.
   * Optional for legacy/test stores. No release-on-EOF or owner-supplied receipt API.
   */
  readonly confirmTerminated?: (
    expected: DirectShellLaunchOwner,
    control: DirectShellLifecycleControl,
  ) => Promise<boolean>;
}
