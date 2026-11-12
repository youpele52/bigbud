import * as Effect from "effect/Effect";
import { getConfiguredRemoteAgentComposition } from "../../remote-agent/remoteAgentDefault.ts";
import { remoteAgentAdmission } from "../../remote-agent/remoteAgentAdmission.ts";
import { ShellProfileDiscoveryError } from "../Services/ShellProfiles";

/** No PTY mutation; dispatch repeats capability checks against its durable reserved binding. */
export const preflightRemoteTerminalShellProfile = Effect.fn(
  "terminal.preflightRemoteShellProfile",
)(function* (executionTargetId: string) {
  yield* Effect.tryPromise({
    try: async () => {
      const composition = getConfiguredRemoteAgentComposition();
      if (!composition?.ptyResolver.restoreOrCreate)
        throw new Error("Explicit profiles require durable remote terminal ownership.");
      const resolve =
        composition.ptyResolver.resolveProfileBinding ??
        (composition.managed ? remoteAgentAdmission.resolveBinding : undefined);
      if (!resolve) throw new Error("Explicit profiles require a pinned execution-host runtime.");
      const binding = await resolve(executionTargetId);
      if (!binding) throw new Error("Remote agent is unavailable.");
      await composition.pool.getBound(executionTargetId, binding, [
        "terminal.pty",
        "workspace.files",
        "terminal.shell-profiles",
      ]);
    },
    catch: () => new ShellProfileDiscoveryError({ reason: "unsupported-target" }),
  });
});
