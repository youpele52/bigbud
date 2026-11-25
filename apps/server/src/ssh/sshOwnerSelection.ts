/**
 * One selector for "is a Rust SSH owner selected?".
 *
 * Production code imports this module, never the dev fixture directly. The
 * answer is true when the build-time production activation is on (W7) **or**
 * when the source-dev fixture activated itself. That keeps the legacy launch
 * fences engaged the moment W7 flips the constant, while leaving today's
 * behaviour unchanged because the constant is off.
 *
 * The caller may pass an explicit activation value; only tests do that. Live
 * call sites use the build-time constant default.
 *
 * ## Fence call sites pending W7 deletion
 *
 * `assertLegacySshLaunchAllowed` still guards these legacy owners because the
 * code they protect is deleted in W7, not in this pass:
 *
 * - `ssh/sshCommand.ts`, `ssh/sshLocalCommand.ts`, `ssh/sshHostTrust.ts`,
 *   `ssh/sshMonitor.ts`
 * - `terminal/Layers/Manager.remote-inspection.ts`,
 *   `terminal/Layers/PtyShellExecutable.ts`,
 *   `terminal-host/localTerminalHost.directSsh.ts`
 * - `codex/codexAppServerManager.process.remote.ts`,
 *   `provider/Layers/Opencode/ServerManager.child.ts`
 * - `remote-backend/clientRelay.ssh.ts`, `remote-backend/peerRelay.ssh.ts`
 * - `git/Layers/GitCore.initiatingFence.ts`, `git/Layers/GitCoreExecutor.ts`,
 *   `git/Layers/GitHubCli.ts`, `tool-transport/toolTransport.ssh.errors.ts`
 *
 * @module sshOwnerSelection
 */
import { SSH_OWNER_PRODUCTION_ACTIVATION } from "@bigbud/shared/SshOwnerActivation";

import { isDevSshOwnerSelected, LegacySshDisabledError } from "./sshOwnerDevMode.fixture.ts";
import { assertLegacySshLaunchAllowedWhen } from "./sshOwnerFence.ts";

export { LegacySshDisabledError };

/** True when the production activation is on or the dev fixture selected an owner. */
export function isSshOwnerSelected(activation: boolean = SSH_OWNER_PRODUCTION_ACTIVATION): boolean {
  return activation || isDevSshOwnerSelected();
}

/** Dev-fixture-only selection, for dev-scoped runtimes that must not start in production. */
export function isSshOwnerDevFixtureSelected(): boolean {
  return isDevSshOwnerSelected();
}

/** The fence every surviving legacy launch runs before it would spawn anything. */
export function assertLegacySshLaunchAllowed(
  activation: boolean = SSH_OWNER_PRODUCTION_ACTIVATION,
): void {
  assertLegacySshLaunchAllowedWhen(isSshOwnerSelected(activation));
}
