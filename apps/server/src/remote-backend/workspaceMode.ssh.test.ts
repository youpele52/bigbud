import { chmodSync, readdirSync, symlinkSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { convertWorkspaceMode } from "./workspaceMode.conversion.ts";
import { reserveWorkspaceMode } from "./workspaceMode.reserve.ts";
import { buildWorkspaceModeInspect, makeShellWorkspaceModeStore } from "./workspaceMode.ssh.ts";
import {
  HOST_IDENTITY,
  makeWorkspaceModeFixture,
  OWNER_A,
  OWNER_B,
} from "./workspaceMode.test.helpers.ts";

// The POSIX shell store executed for real against a temp account home.
describe.runIf(process.platform === "linux" || process.platform === "darwin")(
  "workspace mode shell store",
  () => {
    let f: ReturnType<typeof makeWorkspaceModeFixture> | undefined;
    afterEach(() => {
      f?.close();
      f = undefined;
    });

    it("resolves host identity, account and real path on the host like the local store", async () => {
      f = makeWorkspaceModeFixture();
      const shell = await f.shellStore.inspect(f.workspace);
      const local = await f.localStore.inspect(f.workspace);
      expect(shell).toEqual(local);
      expect(shell).toMatchObject({
        kind: "ready",
        identity: { hostIdentity: HOST_IDENTITY },
        current: null,
      });
    });

    it("symlink_alias_maps_to_same_reservation through the shell", async () => {
      f = makeWorkspaceModeFixture();
      const alias = path.join(f.base, "alias");
      symlinkSync(path.join(f.base, "projects"), alias);
      expect(
        await reserveWorkspaceMode(f.shellStore, `${alias}/app`, "laptop-runtime", OWNER_A),
      ).toMatchObject({
        kind: "reserved",
      });
      expect(
        await reserveWorkspaceMode(f.shellStore, f.workspace, "remote-runtime", OWNER_B),
      ).toMatchObject({
        kind: "conflict",
        holder: { mode: "laptop-runtime" },
      });
      expect(readdirSync(f.modesDir)).toHaveLength(1);
    });

    it("remote_project_refused_on_laptop_runtime_workspace", async () => {
      f = makeWorkspaceModeFixture();
      // A laptop reserves over SSH; the remote backend on the same host reserves locally.
      await reserveWorkspaceMode(f.shellStore, f.workspace, "laptop-runtime", OWNER_A);
      expect(
        await reserveWorkspaceMode(f.localStore, f.workspace, "remote-runtime", OWNER_B),
      ).toMatchObject({
        kind: "conflict",
        holder: { mode: "laptop-runtime", owner: OWNER_A },
      });
      // And the reverse direction.
      const other = path.join(f.base, "projects");
      await reserveWorkspaceMode(f.localStore, other, "remote-runtime", OWNER_B);
      expect(
        await reserveWorkspaceMode(f.shellStore, other, "laptop-runtime", OWNER_A),
      ).toMatchObject({
        kind: "conflict",
        holder: { mode: "remote-runtime" },
      });
    });

    it("concurrent shell conversions: exactly one wins", async () => {
      f = makeWorkspaceModeFixture();
      await reserveWorkspaceMode(f.shellStore, f.workspace, "laptop-runtime", OWNER_A);
      const convert = () =>
        convertWorkspaceMode({
          store: f!.shellStore,
          workspaceRoot: f!.workspace,
          requesterMode: "laptop-runtime",
          targetMode: "remote-runtime",
          isBusy: async () => ({ busy: false }),
        });
      const outcomes = await Promise.all([convert(), convert(), convert()]);
      expect(outcomes.filter((outcome) => outcome.kind === "converted")).toHaveLength(1);
      expect(await f.localStore.inspect(f.workspace)).toMatchObject({
        current: { generation: 2, mode: "remote-runtime", owner: null },
      });
    });

    it("keeps only the previous generation after publishing", async () => {
      f = makeWorkspaceModeFixture();
      await reserveWorkspaceMode(f.shellStore, f.workspace, "laptop-runtime", OWNER_A);
      for (const [from, to] of [
        ["laptop-runtime", "remote-runtime"],
        ["remote-runtime", "laptop-runtime"],
      ] as const)
        await convertWorkspaceMode({
          store: f.shellStore,
          workspaceRoot: f.workspace,
          requesterMode: from,
          targetMode: to,
          isBusy: async () => ({ busy: false }),
        });
      const [key] = readdirSync(f.modesDir);
      expect(readdirSync(path.join(f.modesDir, key!)).toSorted()).toEqual(["2.json", "3.json"]);
    });

    it("refuses public storage and missing folders with clear verdicts", async () => {
      f = makeWorkspaceModeFixture();
      await reserveWorkspaceMode(f.shellStore, f.workspace, "laptop-runtime", OWNER_A);
      chmodSync(f.modesDir, 0o755);
      await expect(f.shellStore.inspect(f.workspace)).rejects.toThrow("with mode 0700");
      chmodSync(f.modesDir, 0o700);
      await expect(f.shellStore.inspect(path.join(f.base, "absent"))).rejects.toThrow(
        "does not exist on the host",
      );
      expect(() => buildWorkspaceModeInspect("relative/path")).toThrow("absolute");
    });

    it("reports unsupported hosts instead of guessing", async () => {
      f = makeWorkspaceModeFixture();
      const store = makeShellWorkspaceModeStore((script) =>
        f!.runShell(`uname() { echo Darwin; }\n${script}`),
      );
      expect(await store.inspect(f.workspace)).toEqual({
        kind: "unsupported",
        reason: "not-linux",
      });
    });
  },
);
