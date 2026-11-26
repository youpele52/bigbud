/**
 * Journal records for Direct SSH panes whose `ssh` client runs in the local terminal host (plan
 * M7). Like a legacy direct-shell owner, a record means "a remote shell may still run for this
 * pane" and names its host for the user. Unlike one, the local host can verify and end it, so it
 * blocks thread deletion only while the host is unreachable, and Forget closes it first.
 *
 * Records share the `direct_shell_launch_owners` table (version 2). The host PTY's own durable
 * owner row stays the recovery authority; this record binds the pane to its SSH target, so a
 * pane never reattaches to another target's session.
 *
 * @module DirectShellLaunch.hosted
 */
import { randomUUID } from "node:crypto";
import * as Schema from "effect/Schema";

import { parseSshExecutionTarget } from "../../ssh/sshExecutionTarget";
import { directShellOwnerKey } from "./DirectShellLaunch.owner";

const Token = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,128}$/));
const PaneId = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(4096));

export const HostedDirectShellOwner = Schema.Struct({
  version: Schema.Literal(2),
  kind: Schema.Literal("local-terminal-host"),
  pane: Schema.Struct({ threadId: PaneId, terminalId: PaneId }),
  ownerKey: Schema.String.check(Schema.isPattern(/^terminal:[a-f0-9]{64}$/)),
  reservationId: Token,
  controllerId: Token,
  executionTargetId: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(4096)),
  /** The table's state column; the host owner row tracks the PTY's real state. */
  state: Schema.Literal("may-have-been-sent"),
  /**
   * The remote login shell's PID, printed once at launch (`remoteShellStartup`). Kept so a PTY
   * reattached after a backend restart still gets real owner busy hints (M7 follow-up).
   */
  remoteShellPid: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(1))),
});
export type HostedDirectShellOwner = typeof HostedDirectShellOwner.Type;

export function parseHostedDirectShellOwner(input: unknown): HostedDirectShellOwner {
  const owner = Schema.decodeUnknownSync(HostedDirectShellOwner)(input, {
    onExcessProperty: "error",
  });
  if (directShellOwnerKey(owner.pane.threadId, owner.pane.terminalId) !== owner.ownerKey)
    throw new Error("Hosted direct shell record pane identity conflict.");
  return structuredClone(owner);
}

/** The record with its remote shell PID set, or removed when `undefined`. */
export function withHostedRemoteShellPid(
  owner: HostedDirectShellOwner,
  remoteShellPid: number | undefined,
): HostedDirectShellOwner {
  const { remoteShellPid: _previous, ...rest } = owner;
  return parseHostedDirectShellOwner(
    remoteShellPid === undefined ? rest : { ...rest, remoteShellPid },
  );
}

/** The SSH host name a person recognises for a hosted record. */
export function hostedDirectShellHost(owner: HostedDirectShellOwner): string {
  return parseSshExecutionTarget(owner.executionTargetId)?.host ?? owner.executionTargetId;
}

/** Whether stored JSON is a version 2 (hosted) record, before choosing its decoder. */
export function isHostedDirectShellRecord(input: unknown): boolean {
  return (
    typeof input === "object" && input !== null && (input as { version?: unknown }).version === 2
  );
}

export function hostedDirectShellOwner(input: {
  readonly threadId: string;
  readonly terminalId: string;
  readonly executionTargetId: string;
}): HostedDirectShellOwner {
  return parseHostedDirectShellOwner({
    version: 2,
    kind: "local-terminal-host",
    pane: { threadId: input.threadId, terminalId: input.terminalId },
    ownerKey: directShellOwnerKey(input.threadId, input.terminalId),
    reservationId: randomUUID(),
    controllerId: randomUUID(),
    executionTargetId: input.executionTargetId,
    state: "may-have-been-sent",
  });
}

export interface HostedDirectShellOwnerStore {
  readonly getHosted: (ownerKey: string) => Promise<HostedDirectShellOwner | undefined>;
  /**
   * Inserts the record unless the pane already has one. A pane with a legacy (version 1) owner
   * refuses: that shell stays fenced exactly as before.
   */
  readonly reserveHosted: (owner: HostedDirectShellOwner) => Promise<{
    readonly created: boolean;
    readonly owner: HostedDirectShellOwner;
  }>;
  /** Removes exactly this record (unchanged since it was read); false when it changed. */
  readonly releaseHosted: (owner: HostedDirectShellOwner) => Promise<boolean>;
  /**
   * Replaces exactly this record (unchanged since it was read) with its remote shell PID set, or
   * cleared when `undefined`. Returns the stored record, or undefined when it changed meanwhile.
   */
  readonly setHostedRemoteShellPid?: (
    owner: HostedDirectShellOwner,
    remoteShellPid: number | undefined,
  ) => Promise<HostedDirectShellOwner | undefined>;
  readonly listHostedForThread: (
    threadId: string,
  ) => Promise<ReadonlyArray<HostedDirectShellOwner>>;
}
