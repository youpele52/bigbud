import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { TerminalEvent } from "@bigbud/contracts";
import type {
  TerminalShellProfile,
  ShellUnconfirmedLaunch,
} from "@bigbud/contracts/workspace/terminalShell.ts";
import { FakePtyAdapter } from "./Manager.test.helpers";
import { makeTerminalManagerWithOptions } from "./Manager.process";
import type { TerminalManagerOptions } from "./Manager.types";
import type { PtySpawnInput } from "../Services/PTY";
import { remoteShellHost } from "./ShellProfiles.remote.identity";
import { shellProfileId } from "./ShellProfiles.identity";
import { resolveShellProfileLaunch, ShellProfileResolutionError } from "./ShellProfiles.launch";
import { historyPath } from "./Manager.history-io";

export const target = "ssh:host=example.test&user=tester&transport=agent";
export const host = remoteShellHost({ executionTargetId: target });
export const profile: TerminalShellProfile = {
  host,
  profileId: shellProfileId(host, "/bin/zsh", ["-o", "nopromptsp"], "linux"),
  executable: "/bin/zsh",
  args: ["-o", "nopromptsp"],
  kind: "zsh",
  displayName: "zsh",
  platform: "linux",
  availability: "available",
  integration: { status: "disabled" },
};
export const selection = { kind: "profile", profileId: profile.profileId } as const;
export const unconfirmed: ShellUnconfirmedLaunch = {
  status: "unconfirmed",
  requestedProfile: { host, profileId: profile.profileId, kind: "zsh" },
};
export class ProfilePtyAdapter extends FakePtyAdapter {
  evidence: ShellUnconfirmedLaunch | undefined = unconfirmed;
  recovered = false;
  override spawn(input: PtySpawnInput) {
    return super.spawn(input).pipe(
      Effect.map((process) =>
        Object.assign(process, {
          pidDomain: "remote" as const,
          launchStatus: "unconfirmed" as const,
          shellUnconfirmedLaunch: this.evidence,
          recovered: this.recovered,
        }),
      ),
    );
  }
}
export const remoteFixture = Effect.fn("test.remoteProfileManager")(function* (
  options: Partial<TerminalManagerOptions> = {},
  history?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const logsDir = yield* fs.makeTempDirectoryScoped({ prefix: "bigbud-manager-profile-" });
  if (history !== undefined)
    yield* fs.writeFileString(historyPath(logsDir, "thread-1", "default"), history);
  const adapter = new ProfilePtyAdapter();
  const targets: string[] = [];
  const events: TerminalEvent[] = [];
  const manager = yield* makeTerminalManagerWithOptions({
    logsDir,
    ptyAdapter: adapter,
    agentDetector: () => Effect.succeed(new Map()),
    preflightRemoteShellProfile: () => Effect.void,
    resolveShellProfile: (selected, context) =>
      Effect.try({
        try: () => {
          targets.push(context.executionTargetId);
          return resolveShellProfileLaunch({ host, profiles: [profile], selection: selected });
        },
        catch: (error) =>
          error instanceof ShellProfileResolutionError
            ? error
            : new ShellProfileResolutionError({ reason: "invalid-profile" }),
      }),
    ...options,
  });
  yield* manager.subscribe((event) =>
    Effect.sync(() => {
      events.push(event);
    }),
  );
  return { manager, adapter, targets, events, logsDir };
});
