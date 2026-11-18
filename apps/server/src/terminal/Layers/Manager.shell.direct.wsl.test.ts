// Exercise sessions admitted by the previous build; production gating has separate tests.
vi.mock("./Manager.shell.direct.policy", async (original) => ({
  ...(await original<typeof import("./Manager.shell.direct.policy")>()),
  assertDirectShellProfileEnabled: () => undefined,
}));
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect, vi } from "vitest";
import { resolveWslTerminalFolder } from "./Manager.wsl";
import { remoteFixture } from "./Manager.shell.remote.test.helpers";
import { fixture, intent } from "./DirectShellLaunch.dispatch.test.helpers";
import { directShellOwnerKey } from "./DirectShellLaunch.owner";
import { FakePtyAdapter, openInput, restartInput } from "./Manager.test.helpers";
import { resolveShellProfileLaunch } from "./ShellProfiles.launch";
import type { ShellProfileTarget } from "../Services/ShellProfiles";

vi.mock("./Manager.wsl", () => ({ resolveWslTerminalFolder: vi.fn() }));
const stored = intent(true);
const identity = stored.wslIdentity!;
const requested = stored.launch.requestedProfile;
const profile = {
  ...requested,
  executable: stored.launch.executable,
  args: stored.launch.args,
  platform: "linux" as const,
  displayName: "zsh",
  availability: "available" as const,
  integration: { status: "disabled" as const },
};
const selection = { kind: "profile" as const, profileId: profile.profileId };
const input = {
  executionTargetId: stored.executionTargetId,
  cwd: "C:\\project",
  shellSelection: selection,
};
const folder = { cwd: "/srv/project", wslIdentity: identity };

it.layer(NodeServices.layer, { excludeTestServices: true })("direct WSL Manager profiles", (it) => {
  it.effect("resolves and dispatches inside the pinned guest, with no desktop shell identity", () =>
    Effect.gen(function* () {
      vi.mocked(resolveWslTerminalFolder).mockReturnValue(Effect.succeed(folder));
      const journal = fixture();
      const adapter = new FakePtyAdapter();
      const targets: ShellProfileTarget[] = [];
      const { manager } = yield* remoteFixture({
        ptyAdapter: adapter,
        directShellOwners: journal.store,
        resolveShellProfile: (selected, target) => {
          targets.push(target);
          return Effect.succeed(
            resolveShellProfileLaunch({
              host: profile.host,
              profiles: [profile],
              selection: selected,
            }),
          );
        },
      });
      const opened = yield* manager.open(openInput(input));
      expect(opened.status).toBe("running");
      expect(opened.wslIdentity).toEqual(identity);
      expect(opened.shellLaunchIdentity).toBeUndefined();
      expect(opened.shellUnconfirmedLaunch?.requestedProfile).toEqual(requested);
      expect(targets).toEqual([
        { executionTargetId: input.executionTargetId, wslIdentity: identity },
      ]);
      const dispatched = adapter.spawnInputs[0]!;
      expect(dispatched.shell).toMatch(/wsl(?:\.exe)?$/);
      expect(dispatched.args?.slice(0, 4)).toEqual([
        "--distribution",
        identity.distribution,
        "--user",
        identity.username,
      ]);
      expect(dispatched.args).toContain(String(identity.uid));
      expect(dispatched.args).toContain(folder.cwd);
      expect(dispatched.args).toContain(profile.executable);
      expect(dispatched.executionTargetId).toBeUndefined();
      expect(
        journal.entries.get(directShellOwnerKey("thread-1", "default"))?.intent.wslIdentity,
      ).toEqual(identity);
      expect((yield* manager.open(openInput(input))).runtimeGeneration).toBe(
        opened.runtimeGeneration,
      );
      expect(targets).toHaveLength(1);
      const refused = yield* manager.restart(restartInput(input)).pipe(Effect.result);
      expect(refused._tag).toBe("Failure");
      if (refused._tag === "Failure")
        expect(refused.failure).toMatchObject({ reason: "restartNotStarted" });
      expect(adapter.processes[0]?.killSignals).toEqual([]);
      expect(adapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("rejects a changed account before reservation or transport dispatch", () =>
    Effect.gen(function* () {
      vi.mocked(resolveWslTerminalFolder).mockReturnValue(
        Effect.succeed({ ...folder, wslIdentity: { ...identity, username: "other", uid: 1001 } }),
      );
      const journal = fixture();
      const adapter = new FakePtyAdapter();
      const { manager } = yield* remoteFixture({
        ptyAdapter: adapter,
        directShellOwners: journal.store,
        resolveShellProfile: (selected) =>
          Effect.succeed(
            resolveShellProfileLaunch({
              host: profile.host,
              profiles: [profile],
              selection: selected,
            }),
          ),
      });
      const result = yield* manager.open(openInput(input)).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(journal.entries.size).toBe(0);
      expect(journal.store.reserve).not.toHaveBeenCalled();
      expect(adapter.spawnInputs).toEqual([]);
    }),
  );
});
