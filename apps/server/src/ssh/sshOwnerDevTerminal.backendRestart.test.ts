import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { release } from "node:os";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { DEV_SSH_OWNER_PROFILE_PREFIX } from "@bigbud/shared/DevLauncher";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { withBaselineServer } from "../server.sshOwnerBaseline.fixture.ts";
import { attemptRawUpgrade } from "../server.test.remote.ts";
import {
  setup,
  selectedRoot,
  trustAndResolveCwd,
  readState,
  executionTargetId,
  target,
  pane,
  key,
} from "./sshOwnerDevTerminal.backendRestart.fixture.ts";

it.skipIf(process.env.BIGBUD_TEST_SSH_OWNER_TERMINAL_BACKEND_RESTART !== "1")(
  "C07 normal source backend restart refuses to replace a retained native SSH PTY",
  async () => {
    if (process.platform !== "darwin" || process.getuid?.() === 0) {
      throw new Error("C07 backend restart requires the disposable non-root macOS DEV fixture");
    }
    const profile = await mkdtemp(`/private/tmp/${DEV_SSH_OWNER_PROFILE_PREFIX}`);
    try {
      const fixture = await setup(profile);
      const first = await fixture.backend("first");
      // SIGTERM to the owned backend handle, with no desktop quit record; not a SIGKILL test.
      const before = await withBaselineServer(first.start(), async (pid) => {
        expect(await attemptRawUpgrade(fixture.ws)).toMatchObject({ upgraded: false, status: 401 });
        const root = await selectedRoot(fixture);
        const cwd = await trustAndResolveCwd(fixture, root);
        const opened = await fixture.rpc((client) =>
          client[WS_METHODS.terminalOpen]({ ...target, ...pane, cwd }),
        );
        expect(opened).toMatchObject({
          status: "running",
          executionTargetId,
          cwd,
          runtimeGeneration: expect.any(String),
        });
        if (opened.pid === null || !opened.runtimeGeneration)
          throw new Error("Missing native PTY identity");
        await fixture.rpc((client) =>
          client[WS_METHODS.terminalWrite]({
            ...pane,
            expectedGeneration: opened.runtimeGeneration!,
            data: "printf '<%s>\\n' \"$((20 + 7))\"\r",
          }),
        );
        await vi.waitFor(async () => {
          const snapshot = await fixture.rpc((client) => client[WS_METHODS.terminalSnapshot](pane));
          expect(snapshot?.history).toMatch(/\r?\n<27>\r?\n/);
        }, 5_000);
        const state = await readState(fixture.dbPath);
        expect(state.routes).toEqual([
          { owner_key: key, route_json: expect.any(String), revision: expect.any(Number) },
        ]);
        const route = JSON.parse(String(state.routes[0]?.route_json));
        expect(route).toMatchObject({
          target: executionTargetId,
          terminalCwd: cwd,
          state: "may-have-been-sent",
          epoch: expect.stringMatching(/^[0-9a-f]{64}$/),
          resourceId: expect.stringMatching(/^[0-9a-f]{64}$/),
          connectionId: expect.stringMatching(/^ssh-owner:[0-9a-f]{64}$/),
        });
        expect(await first.children()).toEqual([
          expect.stringMatching(/^sshd \d+$/),
          expect.stringMatching(/^start-picker-owner \d+$/),
        ]);
        const traffic = await first.traffic();
        expect(traffic).toMatchObject({ authentications: 3, fallback: "" }); // listing, cwd, PTY
        return { pid, root, cwd, ptyPid: opened.pid, route, traffic };
      });
      expect(await first.children()).toEqual([
        expect.stringMatching(/^sshd \d+$/),
        expect.stringMatching(/^start-picker-owner \d+$/),
        "start-picker-owner exited",
        "sshd exited",
      ]);
      await expect(access(before.root)).rejects.toMatchObject({ code: "ENOENT" });
      // Observe only the SSH child reported by the private native terminal. Do not adopt or kill it.
      expect(() => process.kill(before.ptyPid, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
      const { dev, ino } = await stat(fixture.dbPath);
      const saved = await readState(fixture.dbPath);
      expect(saved.routes).toHaveLength(1);
      expect(JSON.parse(String(saved.routes[0]?.route_json))).toMatchObject({
        ...before.route,
        outputSequence: expect.any(Number),
      });
      expect(saved.writer).toEqual({ writer_epoch: expect.any(String) });

      const second = await fixture.backend("second");
      const after = await withBaselineServer(second.start(), async (pid) => {
        expect(pid).not.toBe(before.pid);
        expect(await stat(fixture.dbPath)).toMatchObject({ dev, ino });
        const root = await selectedRoot(fixture);
        expect(root).not.toBe(before.root);
        const open = (attachOnly: boolean) =>
          fixture.rpc((client) =>
            client[WS_METHODS.terminalOpen]({
              ...target,
              ...pane,
              cwd: before.cwd,
              attachOnly,
            }).pipe(Effect.flip),
          );
        // The retained route alone does not admit a renderer attach-only request.
        await expect(open(true)).resolves.toMatchObject({ _tag: "TerminalNotRunningError" });
        // Ordinary Open cannot remap the old pane directory onto the new fixture.
        await expect(open(false)).resolves.toMatchObject({
          _tag: "TerminalExecutionTargetError",
          detail: "Could not resolve the terminal folder through the selected SSH owner.",
        });
        await expect(
          fixture.rpc((client) => client[WS_METHODS.terminalSnapshot](pane).pipe(Effect.flip)),
        ).resolves.toMatchObject({ _tag: "TerminalSessionLookupError", ...pane });
        const reopened = await readState(fixture.dbPath);
        expect(reopened.routes).toEqual(saved.routes);
        // Writer hydrates lazily with the owner. Rejected reattach must not even start one.
        expect(reopened.writer).toEqual(saved.writer);
        expect(await second.children()).toEqual([expect.stringMatching(/^sshd \d+$/)]);
        expect(await second.traffic()).toEqual({
          connections: 0,
          authentications: 0,
          fallback: "",
        });
        return { pid, root };
      });
      expect(await second.children()).toEqual([expect.stringMatching(/^sshd \d+$/), "sshd exited"]);
      await expect(access(after.root)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readState(fixture.dbPath)).toEqual(saved);
      console.info("C07 native SSH terminal normal backend restart (fail closed)", {
        platform: `${process.platform}/${process.arch} (${release()})`,
        backendPids: [before.pid, after.pid],
        originalPtyPid: before.ptyPid,
        sqliteInode: ino,
        firstTraffic: before.traffic,
        secondTraffic: await second.traffic(),
      });
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  },
  120_000,
);
