import * as Schema from "effect/Schema";
import {
  ShellLaunchIntent,
  TerminalShellProfile,
} from "@bigbud/contracts/workspace/terminalShell.ts";
import { shellKind, shellProfileId } from "./ShellProfiles.identity";

/** Immutable execution-host launch intent. It is never evidence of successful exec. */
export const ExecutionHostShellLaunch = Schema.Struct({
  version: Schema.Literal(1),
  cwd: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(4096)),
  requestedProfile: ShellLaunchIntent,
  executable: TerminalShellProfile.fields.executable,
  args: TerminalShellProfile.fields.args,
  platform: Schema.Literals(["linux", "darwin"]),
  integration: Schema.Literal("disabled"),
});
export type ExecutionHostShellLaunch = typeof ExecutionHostShellLaunch.Type;

export function parseExecutionHostShellLaunch(input: unknown): ExecutionHostShellLaunch {
  const launch = Schema.decodeUnknownSync(ExecutionHostShellLaunch)(input);
  if (Buffer.byteLength(JSON.stringify(launch)) > 8192)
    throw new Error("Remote shell launch intent is too large.");
  const { host, profileId, kind } = launch.requestedProfile;
  if (host.kind === "local") throw new Error("Remote shell launch cannot use a local profile.");
  if (host.kind === "wsl" && launch.platform !== "linux")
    throw new Error("WSL shell launch requires a Linux profile.");
  if (
    !launch.executable.startsWith("/") ||
    !launch.cwd.startsWith("/") ||
    launch.cwd.includes("\0") ||
    /[\r\n]/.test(launch.cwd)
  )
    throw new Error("Remote shell launch requires absolute execution-host paths.");
  if (
    shellProfileId(host, launch.executable, launch.args, launch.platform) !== profileId ||
    shellKind(launch.executable, launch.platform) !== kind
  )
    throw new Error("Remote shell launch profile does not match its executable and arguments.");
  return launch;
}
