import { access, link, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Writable } from "node:stream";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import {
  DEV_SSH_OWNER_PROFILE_PREFIX,
  DEV_SSH_OWNER_RETAIN_MARKER,
} from "@bigbud/shared/DevLauncher";
import { expect, it, vi } from "vitest";
import { withBaselineServer } from "../server.sshOwnerBaseline.fixture.ts";
import { attemptRawUpgrade } from "../server.test.remote.ts";
import { retainedHandoff } from "./sshOwnerDevRuntime.retained.ts";
import {
  executionTargetId,
  key,
  pane,
  readState,
  selectedRoot,
  setup,
  target,
  trustAndResolveCwd,
} from "./sshOwnerDevTerminal.backendRestart.fixture.ts";

const optIn = process.env.BIGBUD_TEST_SSH_OWNER_TERMINAL_BACKEND_RESTART === "1";
const historyMarker = /\r?\n<27>\r?\n/;
const gone = (pid: number) =>
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));

it.skipIf(!optIn).each([true, false])(
  "C07 replaces Bun while retaining the same stock OpenSSH PTY (explicit quit: %s)",
  async (quit) => {
    if (process.platform !== "darwin" || process.getuid?.() === 0)
      throw new Error("C07 requires the non-root macOS Bun development fixture");
    const profile = await mkdtemp(`/private/tmp/${DEV_SSH_OWNER_PROFILE_PREFIX}`);
    try {
      await writeFile(path.join(profile, DEV_SSH_OWNER_RETAIN_MARKER), "", {
        flag: "wx",
        mode: 0o600,
      });
      const fixture = await setup(profile);
      const launcher = await fixture.backend("launcher");
      const supervisor = launcher.startSupervisor();
      try {
        await supervisor.ready;
        const first = await fixture.backend("first", true);
        const before = await withBaselineServer(
          first.start(),
          async (pid) => {
            expect(await attemptRawUpgrade(fixture.ws)).toMatchObject({
              upgraded: false,
              status: 401,
            });
            const root = await selectedRoot(fixture);
            const cwd = await trustAndResolveCwd(fixture, root);
            const opened = await fixture.rpc((client) =>
              client[WS_METHODS.terminalOpen]({ ...target, ...pane, cwd }),
            );
            expect(opened).toMatchObject({ status: "running", executionTargetId, cwd });
            if (!opened.pid || !opened.runtimeGeneration)
              throw new Error("Missing native PTY identity");
            await fixture.rpc((client) =>
              client[WS_METHODS.terminalWrite]({
                ...pane,
                expectedGeneration: opened.runtimeGeneration!,
                data: "printf '<%s>\\n' \"$((20 + 7))\"\r",
              }),
            );
            await vi.waitFor(async () => {
              expect(
                (await fixture.rpc((client) => client[WS_METHODS.terminalSnapshot](pane)))?.history,
              ).toMatch(historyMarker);
            }, 5_000);
            return { pid, root, cwd, ptyPid: opened.pid };
          },
          "SIGKILL",
        );
        expect(() => process.kill(before.ptyPid, 0)).not.toThrow();
        const { dev, ino } = await stat(fixture.dbPath);
        const saved = await readState(fixture.dbPath);
        expect(saved.routes).toEqual([
          { owner_key: key, route_json: expect.any(String), revision: expect.any(Number) },
        ]);
        const route = JSON.parse(String(saved.routes[0]?.route_json));
        expect(route).toMatchObject({
          target: executionTargetId,
          terminalCwd: before.cwd,
          state: "may-have-been-sent",
          epoch: expect.stringMatching(/^[0-9a-f]{64}$/),
          resourceId: expect.stringMatching(/^[0-9a-f]{64}$/),
          connectionId: expect.stringMatching(/^ssh-owner:[0-9a-f]{64}$/),
        });
        const traffic = await launcher.traffic();
        expect(traffic).toEqual({
          connections: expect.any(Number),
          authentications: 3,
          fallback: "",
        });
        expect(traffic.connections).toBeGreaterThan(0);
        expect(await first.children()).toEqual([]);
        expect((await first.traffic()).fallback).toBe("");
        const processes = await launcher.children();
        expect(processes).toEqual([
          expect.stringMatching(/^sshd \d+$/),
          expect.stringMatching(/^start-picker-owner \d+$/),
        ]);

        const second = await fixture.backend("second", true, quit);
        const child = second.start();
        const streams: readonly unknown[] = child.stdio;
        const quitPipe = streams[5];
        await withBaselineServer(
          child,
          async (pid) => {
            try {
              expect(pid).not.toBe(before.pid);
              await expect(stat(fixture.dbPath)).resolves.toMatchObject({ dev, ino });
              expect(await selectedRoot(fixture)).toBe(before.root);
              const recovered = await fixture.rpc((client) =>
                client[WS_METHODS.terminalOpen]({
                  ...target,
                  ...pane,
                  cwd: before.cwd,
                  attachOnly: true,
                }),
              );
              expect(recovered).toMatchObject({
                pid: before.ptyPid,
                status: "running",
                cwd: before.cwd,
              });
              await vi.waitFor(async () => {
                expect(
                  (await fixture.rpc((client) => client[WS_METHODS.terminalSnapshot](pane)))
                    ?.history,
                ).toMatch(historyMarker);
              }, 5_000);
              const generation = recovered.runtimeGeneration;
              if (!generation) throw new Error("Missing recovered renderer generation");
              await fixture.rpc((client) =>
                client[WS_METHODS.terminalWrite]({
                  ...pane,
                  expectedGeneration: generation,
                  data: "printf '<%s>\\n' \"$((20 + 11))\"\r",
                }),
              );
              await vi.waitFor(async () => {
                const history =
                  (await fixture.rpc((client) => client[WS_METHODS.terminalSnapshot](pane)))
                    ?.history ?? "";
                expect(history).toMatch(/\r?\n<31>\r?\n/);
                expect(history.match(/\r?\n<27>\r?\n/g)).toHaveLength(1);
              }, 5_000);
              const active = await readState(fixture.dbPath);
              expect(active.writer).not.toEqual(saved.writer);
              expect(JSON.parse(String(active.routes[0]?.route_json))).toMatchObject({
                ...route,
                outputSequence: expect.any(Number),
              });
              expect(await launcher.traffic()).toEqual(traffic);
              expect(await launcher.children()).toEqual(processes);
              expect(await second.children()).toEqual([]);
              expect((await second.traffic()).fallback).toBe("");
              if (quit) {
                if (!(quitPipe instanceof Writable))
                  throw new Error("Missing inherited quit channel");
                await new Promise<void>((resolve, reject) => {
                  quitPipe.once("error", reject);
                  // Close the test's writer too: the Bun inherited socket may otherwise block
                  // its synchronous shutdown drain waiting for another byte.
                  quitPipe.end(
                    `${JSON.stringify({ kind: "quit", sequence: 1, reason: "quit", occurredAt: Date.now(), online: null })}\n`,
                    resolve,
                  );
                });
              }
            } finally {
              if (quit && quitPipe instanceof Writable && !quitPipe.writableEnded) quitPipe.end();
            }
          },
          quit ? "SIGTERM" : "SIGKILL",
        );
        if (quit) {
          gone(before.ptyPid);
          const closed = await readState(fixture.dbPath);
          expect(JSON.parse(String(closed.routes[0]?.route_json))).toMatchObject({
            ...route,
            state: "terminal",
            outputSequence: expect.any(Number),
          });
        } else {
          expect(() => process.kill(before.ptyPid, 0)).not.toThrow();
        }
        expect(await launcher.children()).toEqual(processes);
        await supervisor.stop();
        gone(before.ptyPid);
        expect(await launcher.children()).toEqual([
          ...processes,
          "start-picker-owner exited",
          "sshd exited",
        ]);
        await expect(access(before.root)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await supervisor.stop();
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  },
  120_000,
);

it.skipIf(!optIn)(
  "rejects linked or unauthenticated handoffs without starting another owner",
  async () => {
    const profile = await mkdtemp(`/private/tmp/${DEV_SSH_OWNER_PROFILE_PREFIX}`);
    try {
      await writeFile(path.join(profile, DEV_SSH_OWNER_RETAIN_MARKER), "", {
        flag: "wx",
        mode: 0o600,
      });
      const fixture = await setup(profile);
      const launcher = await fixture.backend("launcher");
      const supervisor = launcher.startSupervisor();
      try {
        await supervisor.ready;
        const original = await readState(fixture.dbPath);
        const handoff = retainedHandoff(profile);
        const extraLink = `${handoff}.linked`;
        await link(handoff, extraLink);
        const first = await fixture.backend("first", true);
        await expect(
          withBaselineServer(first.start(), async () => {
            throw new Error("Unexpected readiness");
          }),
        ).rejects.toThrow("supervised disposable SSH owner is unavailable");
        await rm(extraLink);
        expect(await first.children()).toEqual([]);
        const tampered = JSON.parse(await readFile(handoff, "utf8"));
        tampered.capability = randomBytes(32).toString("hex");
        await writeFile(handoff, JSON.stringify(tampered));
        const second = await fixture.backend("second", true);
        await expect(
          withBaselineServer(second.start(), async () => {
            throw new Error("Unexpected readiness");
          }),
        ).rejects.toThrow("supervised disposable SSH owner is unavailable");
        expect(await second.children()).toEqual([]);
        expect(await launcher.children()).toEqual([
          expect.stringMatching(/^sshd \d+$/),
          expect.stringMatching(/^start-picker-owner \d+$/),
        ]);
        expect(await launcher.traffic()).toMatchObject({ authentications: 0, fallback: "" });
        expect(await readState(fixture.dbPath)).toEqual(original);
      } finally {
        await supervisor.stop();
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  },
  60_000,
);
