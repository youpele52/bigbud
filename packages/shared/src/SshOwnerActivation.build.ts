/**
 * Bundle-time half of `SshOwnerActivation`. The server and desktop tsdown
 * configs call this to decide whether the bundle may honour the temporary
 * `BIGBUD_SSH_OWNER_ACTIVATION` override.
 *
 * Allowed only for a local build: a `--watch` dev bundle, or an explicit
 * `BIGBUD_SSH_OWNER_ACTIVATION_LOCAL_BUILD=1` at build time. Any CI build
 * (`CI` or `GITHUB_ACTIONS` set), which includes every release workflow, is
 * forced off regardless, so a release bundle carries a literal `false`.
 *
 * @module SshOwnerActivation.build
 */

export const SSH_OWNER_ACTIVATION_LOCAL_BUILD_ENV = "BIGBUD_SSH_OWNER_ACTIVATION_LOCAL_BUILD";
export const SSH_OWNER_ACTIVATION_DEFINE = "__BIGBUD_SSH_OWNER_ACTIVATION_OVERRIDE_ALLOWED__";

function truthy(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

export function sshOwnerActivationOverrideAllowedAtBuild(
  argv: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
): boolean {
  if (truthy(environment.CI) || truthy(environment.GITHUB_ACTIONS)) return false;
  return argv.includes("--watch") || environment[SSH_OWNER_ACTIVATION_LOCAL_BUILD_ENV] === "1";
}

/** The tsdown `define` entry; the value is a JSON literal. */
export function sshOwnerActivationDefine(
  argv: ReadonlyArray<string> = process.argv,
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    [SSH_OWNER_ACTIVATION_DEFINE]: JSON.stringify(
      sshOwnerActivationOverrideAllowedAtBuild(argv, environment),
    ),
  };
}
