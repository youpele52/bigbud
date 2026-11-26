import { isAbsolute, normalize } from "node:path";

/**
 * Locates the Rust SSH owner the backend must use. SSH always runs through the
 * owner (S4); there is no legacy launcher to fall back to.
 *
 * - Packaged: the staged owner beside the bundled server. The server re-verifies
 *   the artifact's native target and fails closed with `sshOwnerUnavailable`, so
 *   this is a locator, not a trust decision.
 * - Development (`bun run dev:desktop`): the absolute Cargo artifact the dev
 *   runner built and exported as `BIGBUD_SSH_OWNER_BIN`.
 */
export function resolveDesktopSshOwnerBinary(input: {
  readonly isPackaged: boolean;
  readonly packagedBinary: string | null;
  readonly environment: NodeJS.ProcessEnv;
}): string | undefined {
  if (input.isPackaged) return input.packagedBinary ?? undefined;
  const value = input.environment.BIGBUD_SSH_OWNER_BIN;
  return value !== undefined && isAbsolute(value) && normalize(value) === value ? value : undefined;
}
