/**
 * Activation switch for Rust SSH ownership (S4).
 *
 * This is the **single switch point** for the production cutover described in
 * `docs/plans/2026-11-23-rust-ssh-ownership-s4-cutover-design.md` §f. Every
 * consumer reads `SSH_OWNER_PRODUCTION_ACTIVATION` (or calls
 * `resolveSshOwnerActivation`) from here; nothing else decides owner selection.
 *
 * ## Temporary local override
 *
 * Until W7 makes SSH Rust-only, a **local** build may turn the owner on with
 * `BIGBUD_SSH_OWNER_ACTIVATION=1`. Release builds ignore it, so nothing ships
 * activated. Whether the override is honoured is fixed **at bundle time** by
 * the `__BIGBUD_SSH_OWNER_ACTIVATION_OVERRIDE_ALLOWED__` define that the server
 * and desktop tsdown configs compute with `sshOwnerActivationOverrideAllowedAtBuild`
 * (see `SshOwnerActivation.build.ts`). An end user cannot change a bundled
 * literal; a source run (`bun run dev`, Vitest) has no define and is a local
 * checkout by definition.
 *
 * `BIGBUD_SSH_OWNER_DRAIN_IDENTIFIED=1` is the matching explicit drain request
 * for a fenced activated startup (W3.6); it follows the same override rule.
 *
 * Removing the flag at W7 is a one-place change: make
 * `resolveSshOwnerActivation` return `true` and delete the override plumbing.
 *
 * @module SshOwnerActivation
 */

declare const __BIGBUD_SSH_OWNER_ACTIVATION_OVERRIDE_ALLOWED__: boolean | undefined;

export const SSH_OWNER_ACTIVATION_ENV = "BIGBUD_SSH_OWNER_ACTIVATION";
export const SSH_OWNER_DRAIN_IDENTIFIED_ENV = "BIGBUD_SSH_OWNER_DRAIN_IDENTIFIED";

/** The bundle-time decision; `true` only for a source run or an opted-in local bundle. */
export function sshOwnerActivationOverrideAllowed(): boolean {
  return typeof __BIGBUD_SSH_OWNER_ACTIVATION_OVERRIDE_ALLOWED__ === "boolean"
    ? __BIGBUD_SSH_OWNER_ACTIVATION_OVERRIDE_ALLOWED__
    : true;
}

export interface SshOwnerActivationInput {
  readonly environment?: NodeJS.ProcessEnv;
  /** Tests only; production uses the bundle-time define. */
  readonly overrideAllowed?: boolean;
}

function honoured(name: string, input: SshOwnerActivationInput): boolean {
  const allowed = input.overrideAllowed ?? sshOwnerActivationOverrideAllowed();
  return allowed && (input.environment ?? process.env)[name] === "1";
}

/** The single resolver. Default off; release bundles always resolve off. */
export function resolveSshOwnerActivation(input: SshOwnerActivationInput = {}): boolean {
  return honoured(SSH_OWNER_ACTIVATION_ENV, input);
}

/** Explicit drain request for a fenced startup; never honoured unless activated. */
export function resolveSshOwnerDrainIdentifiedRequest(
  input: SshOwnerActivationInput = {},
): boolean {
  return resolveSshOwnerActivation(input) && honoured(SSH_OWNER_DRAIN_IDENTIFIED_ENV, input);
}

/** Resolved once at module load so every consumer sees the same answer. */
export const SSH_OWNER_PRODUCTION_ACTIVATION: boolean = resolveSshOwnerActivation();
