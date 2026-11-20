/**
 * Ownership and mode refusals for owner-private backend paths, with an actionable reason.
 *
 * The checks keep refusing exactly as before; the thrown error only carries which path was
 * refused, its observed mode and the accepted modes, so the CLI can say what to fix
 * (`chmod 600 …` / `chmod 700 …`). Nothing read from the path is ever included.
 *
 * @module privatePermission
 */
import type { BigIntStats } from "node:fs";

import { hasLocalSupervisorServiceControls } from "./localSupervisorService.paths.ts";

export type PrivatePathKind = "file" | "directory";

export interface PrivatePermissionDetail {
  readonly kind: PrivatePathKind;
  readonly path: string;
  /** Accepted exact modes (permission bits only), most private first. */
  readonly allowedModes: ReadonlyArray<number>;
  readonly actualMode: number;
  readonly ownedByAccount: boolean;
  /** What the path is to the user, e.g. "trusted-keys file (--trusted-keys)". */
  readonly role?: string | undefined;
}

export class PrivatePermissionError extends Error {
  readonly _tag = "PrivatePermissionError" as const;
  constructor(
    message: string,
    readonly detail: PrivatePermissionDetail,
  ) {
    super(message);
    this.name = "PrivatePermissionError";
  }
}

const accountUid = () => (process.getuid ? BigInt(process.getuid()) : null);

/** Refuses a stat not owned by this account or whose exact mode is not allowed. */
export function assertPrivateOwnership(
  stat: BigIntStats,
  input: {
    readonly kind: PrivatePathKind;
    readonly path: string;
    readonly allowedModes: ReadonlyArray<number>;
    readonly message: string;
    readonly role?: string | undefined;
  },
): void {
  const uid = accountUid();
  if (uid === null) throw new Error(input.message);
  const actualMode = Number(stat.mode & 0o7777n);
  const ownedByAccount = stat.uid === uid;
  if (ownedByAccount && input.allowedModes.includes(actualMode)) return;
  throw new PrivatePermissionError(input.message, {
    kind: input.kind,
    path: input.path,
    allowedModes: input.allowedModes,
    actualMode,
    ownedByAccount,
    role: input.role,
  });
}

/** Runs a check and names the refused path's role for the user, keeping the refusal. */
export async function labelPrivatePermission<T>(role: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof PrivatePermissionError && cause.detail.role === undefined)
      throw new PrivatePermissionError(cause.message, { ...cause.detail, role });
    throw cause;
  }
}

const octal = (mode: number) => mode.toString(8).padStart(4, "0");
const bits = (mode: number) => mode.toString(2).replaceAll("0", "").length;

/** The accepted mode that keeps most of the current permission bits. */
function suggestedMode(detail: PrivatePermissionDetail): number {
  let best = detail.allowedModes[0] ?? (detail.kind === "file" ? 0o600 : 0o700);
  for (const mode of detail.allowedModes)
    if (bits(detail.actualMode & mode) > bits(detail.actualMode & best)) best = mode;
  return best;
}

const MAX_PATH_LENGTH = 1024;

/** A shell-safe quoted path, or undefined when the path must not be echoed. */
function quotedPath(path: string): string | undefined {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH || hasLocalSupervisorServiceControls(path))
    return undefined;
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/** One actionable line: which path, the observed and required mode, and the command to fix it. */
export function describePrivatePermission(detail: PrivatePermissionDetail): string {
  const quoted = quotedPath(detail.path);
  const what = `The ${detail.role ?? detail.kind}${quoted ? ` ${quoted}` : ""}`;
  const required = detail.allowedModes.map(octal).join(" or ");
  if (!detail.ownedByAccount)
    return (
      `${what} is not owned by this account; it must be owned by this account with mode ` +
      `${required}. Recreate it as this account${quoted ? `, or run: chown "$(id -u)" ${quoted}` : "."}`
    );
  const mode = suggestedMode(detail).toString(8);
  const note = detail.allowedModes.every((allowed) => (allowed & 0o077) === 0)
    ? "private to this account"
    : "not writable by other users";
  return (
    `${what} has mode ${octal(detail.actualMode)}; it must be ${required} (${note}). ` +
    (quoted ? `Run: chmod ${mode} ${quoted}` : `Run chmod ${mode} on it.`)
  );
}
