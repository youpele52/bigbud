import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { expect } from "vitest";
import type {
  ShellSelection,
  TerminalShellProfile,
} from "@bigbud/contracts/workspace/terminalShell.ts";
import { createManager, openInput, restartInput, historyLogPath } from "./Manager.test.helpers";
import { LOCAL_SHELL_HOST, shellProfileId } from "./ShellProfiles.identity";
import { resolveShellProfileLaunch, ShellProfileResolutionError } from "./ShellProfiles.launch";
import { localShellDefaultsEnabled } from "../../constants/terminalShells";

const profile: TerminalShellProfile = {
  profileId: shellProfileId(LOCAL_SHELL_HOST, "/bin/zsh", [], "darwin"),
  host: LOCAL_SHELL_HOST,
  kind: "zsh",
  displayName: "zsh",
  executable: "/bin/zsh",
  args: [],
  platform: "darwin",
  availability: "available",
  integration: { status: "disabled" },
};
const selected: ShellSelection = { kind: "profile", profileId: profile.profileId };
const resolve = (selection: ShellSelection) =>
  Effect.try({
    try: () =>
      resolveShellProfileLaunch({ host: LOCAL_SHELL_HOST, selection, profiles: [profile] }),
    catch: () => new ShellProfileResolutionError({ reason: "missing-profile" }),
  });

it("keeps Windows and unknown platforms gated", () => {
  expect(localShellDefaultsEnabled("win32")).toBe(false);
  expect(localShellDefaultsEnabled("freebsd")).toBe(false);
  expect(localShellDefaultsEnabled("darwin")).toBe(true);
  expect(localShellDefaultsEnabled("linux")).toBe(true);
});

it.layer(NodeServices.layer, { excludeTestServices: true })("local default consumption", (it) => {
  it.effect(
    "uses current defaults only for new terminals; explicit automatic, reattach and restart win",
    () =>
      Effect.gen(function* () {
        let choice: ShellSelection = selected;
        let reads = 0;
        const { manager, ptyAdapter } = yield* createManager(5, {
          getLocalShellDefault: () => {
            reads++;
            return choice;
          },
          resolveShellProfile: resolve,
        });
        const first = yield* manager.open(openInput());
        expect(first.shellLaunchIdentity?.selection).toEqual(selected);
        choice = { kind: "legacy-auto" };
        expect((yield* manager.open(openInput())).shellLaunchIdentity).toEqual(
          first.shellLaunchIdentity,
        );
        expect((yield* manager.restart(restartInput())).shellLaunchIdentity).toEqual(
          first.shellLaunchIdentity,
        );
        expect(reads).toBe(1);
        const next = yield* manager.open(openInput({ terminalId: "next" }));
        expect(next.shellLaunchIdentity?.selection).toEqual(choice);
        choice = selected;
        yield* manager.open(
          openInput({ terminalId: "explicit", shellSelection: { kind: "legacy-auto" } }),
        );
        expect(reads).toBe(2);
        expect(ptyAdapter.spawnInputs).toHaveLength(4);
      }),
  );
  it.effect("missing selected default fails without shell substitution or spawning", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        getLocalShellDefault: () => ({ kind: "profile", profileId: "missing" }),
        resolveShellProfile: resolve,
      });
      const result = yield* manager.open(openInput()).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(ptyAdapter.spawnInputs).toHaveLength(0);
    }),
  );
  it.effect("retained disk history is not a new terminal after server restart", () =>
    Effect.gen(function* () {
      const { manager, logsDir } = yield* createManager(5, {
        getLocalShellDefault: () => selected,
        resolveShellProfile: () => {
          throw new Error("must not resolve a new profile for existing terminal");
        },
      });
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(historyLogPath(logsDir), "previous terminal");
      const opened = yield* manager.open(openInput());
      expect(opened.shellLaunchIdentity?.selection).toEqual({ kind: "legacy-auto" });
    }),
  );
});
