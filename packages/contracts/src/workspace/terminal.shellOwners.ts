import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "../core/baseSchemas";
import { TerminalThreadInput } from "./terminal";

/**
 * Direct SSH/WSL shell ownership records retained for one thread. Such a record blocks the
 * thread's deletion because its remote shell may still be running and cannot be verified.
 */
export const TerminalRetainedShellOwnersInput = TerminalThreadInput;
export type TerminalRetainedShellOwnersInput = typeof TerminalRetainedShellOwnersInput.Type;

export const TerminalRetainedShellOwners = Schema.Struct({
  /** Hosts whose shells may still be running, for the user's confirmation. */
  hosts: Schema.Array(TrimmedNonEmptyString),
  count: NonNegativeInt,
});
export type TerminalRetainedShellOwners = typeof TerminalRetainedShellOwners.Type;

export const TerminalForgetRetainedShellOwnersResult = Schema.Struct({
  forgotten: NonNegativeInt,
});
export type TerminalForgetRetainedShellOwnersResult =
  typeof TerminalForgetRetainedShellOwnersResult.Type;
