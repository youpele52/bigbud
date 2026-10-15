import { mkdir, lstat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import { V2ImplementationSelection } from "./Orchestration.implementation.selection.ts";
import {
  V2ThreadImplementationRegistry,
  v2ThreadImplementation,
} from "./Orchestration.implementation.ts";
import { acquireV2PluginPublicationLock } from "./PluginSetup.lock.ts";
import { v2NativePluginDirectory } from "./PluginSetup.fs.ts";
import { runV2RequestContext } from "./Client.guard.ts";
import { V2ActivationWindow } from "./PluginSetup.activation.window.ts";
import { deferred } from "./Test.fixtures.ts";

const hook = vi.hoisted(() => ({
  target: "",
  phase: "directory",
  lose: () => {},
  expired: false,
  lateWrites: 0,
  lateSyncs: 0,
  wait: undefined as undefined | (() => Promise<void>),
}));
vi.mock("./PluginSetup.fs.ts", async (original) => {
  const fs = await original<typeof import("./PluginSetup.fs.ts")>();
  return {
    ...fs,
    v2NativePluginDirectory: async (...args: Parameters<typeof fs.v2NativePluginDirectory>) => {
      const result = await fs.v2NativePluginDirectory(...args);
      if (args[0] === hook.target && hook.phase === "directory") queueMicrotask(hook.lose);
      return result;
    },
  };
});
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (
        String(args[0]) === path.join(hook.target, ".bigbud-thread-tools-managed.lock") &&
        typeof args[1] === "number"
      ) {
        const write = handle.writeFile.bind(handle),
          sync = handle.sync.bind(handle);
        handle.writeFile = async (...input: Parameters<typeof handle.writeFile>) => {
          if (hook.expired) hook.lateWrites++;
          await write(...input);
          await hook.wait?.();
          if (hook.phase === "write") queueMicrotask(hook.lose);
        };
        handle.sync = async () => {
          if (hook.expired) hook.lateSyncs++;
          await sync();
        };
      }
      return handle;
    },
  };
});

it.each(["record", "default"] as const)(
  "%s held physical lock write cannot sync or publish after the actual 15-second deadline; its evidence stays owned until settlement",
  async (purpose) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const app = await makeV2ThreadPluginFixture(),
      held = deferred<void>(),
      entered = deferred<void>();
    const permit = {
      revision: 1,
      signal: new AbortController().signal,
      assertCurrent: () => {},
      release: () => {},
    };
    const records = await V2ThreadRecords.open(
        app.artifact.root,
        "enrollments",
        app.artifact.privateKey,
        app.artifact.publicKey,
      ),
      registry = new V2ThreadImplementationRegistry(),
      selection = await V2ImplementationSelection.open(app.artifact, registry);
    const directory =
      purpose === "record"
        ? path.join(
            app.artifact.root,
            "record-locks",
            createHash("sha256")
              .update(JSON.stringify([records.directory, "owned"]))
              .digest("hex"),
          )
        : path.join(app.artifact.root, "implementation-locks");
    hook.target = directory;
    hook.phase = "held";
    hook.expired = false;
    hook.lateSyncs = 0;
    hook.wait = async () => {
      entered.resolve();
      await held.promise;
    };
    let gateReleased = false,
      physicallySettled = false;
    const window = new V2ActivationWindow(Date.now() + 15000, new AbortController().signal, () => {
      gateReleased = true;
      hook.expired = true;
    });
    try {
      const observer = runV2RequestContext(
        { transport: "owned-short-scope", permit, intent: "execute" },
        () =>
          window.run(async () => {
            try {
              if (purpose === "record")
                await records.replace("owned", undefined, { pending: true });
              else
                await selection.select("v2", {
                  signal: new AbortController().signal,
                  assertCurrent: () => {},
                });
            } finally {
              physicallySettled = true;
            }
          }),
      );
      const observed = observer.catch(() => "expired");
      await entered.promise;
      await vi.advanceTimersByTimeAsync(15000);
      expect(await observed).toBe("expired");
      expect(gateReleased).toBe(true);
      expect(physicallySettled).toBe(false);
      const filename = path.join(directory, ".bigbud-thread-tools-managed.lock"),
        inode = (await lstat(filename)).ino;
      held.resolve();
      await window.drain();
      expect(physicallySettled).toBe(true);
      expect(hook.lateSyncs).toBe(0);
      expect((await lstat(filename)).ino).toBe(inode);
      expect(JSON.parse(await readFile(filename, "utf8"))).toMatchObject({ pid: process.pid });
      expect(await records.read("owned")).toBeUndefined();
      expect(registry.current()).toBe(v2ThreadImplementation("v1"));
    } finally {
      held.resolve();
      window.release();
      await window.drain();
      hook.target = "";
      hook.wait = undefined;
      await app.close();
      vi.useRealTimers();
    }
  },
);

it.each(["record", "default", "publisher"] as const)(
  "%s lock captures short-operation and explicit caller authority, and fences sync after write",
  async (purpose) => {
    for (const phase of ["directory", "write"] as const)
      for (const loss of ["operation", "caller", "consent"] as const) {
        const app = await makeV2ThreadPluginFixture(),
          caller = new AbortController();
        let operationCurrent = true,
          consentCurrent = true;
        const permit = {
          revision: 1,
          signal: new AbortController().signal,
          release: () => {},
          assertCurrent: () => {
            if (!consentCurrent) throw new Error("V2 revoked consent");
          },
        };
        const authority = { signal: caller.signal, assertCurrent: permit.assertCurrent };
        const records = await V2ThreadRecords.open(
          app.artifact.root,
          "enrollments",
          app.artifact.privateKey,
          app.artifact.publicKey,
        );
        const registry = new V2ThreadImplementationRegistry(),
          selection = await V2ImplementationSelection.open(app.artifact, registry);
        const directory =
          purpose === "record"
            ? path.join(
                app.artifact.root,
                "record-locks",
                createHash("sha256")
                  .update(JSON.stringify([records.directory, "owned"]))
                  .digest("hex"),
              )
            : path.join(
                app.artifact.root,
                purpose === "default" ? "implementation-locks" : "publisher-lock",
              );
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const identity = await v2NativePluginDirectory(directory);
        hook.target = directory;
        hook.phase = phase;
        hook.expired = false;
        hook.lateWrites = 0;
        hook.lateSyncs = 0;
        hook.lose = () => {
          hook.expired = true;
          if (loss === "operation") operationCurrent = false;
          else if (loss === "consent") consentCurrent = false;
          else caller.abort();
        };
        try {
          await expect(
            runV2RequestContext(
              {
                transport: "synthetic-scope",
                permit,
                intent: "execute",
                operationGuard: () => {
                  if (!operationCurrent) throw new Error("V2 short operation deadline expired");
                },
              },
              async () => {
                if (purpose === "record") {
                  await records.replace("owned", undefined, { pending: true }, authority);
                } else if (purpose === "default") await selection.select("v2", authority);
                else {
                  const release = await acquireV2PluginPublicationLock(
                    directory,
                    identity,
                    app.root,
                    app.artifact,
                    authority,
                  );
                  await release();
                }
              },
            ),
          ).rejects.toThrow();
          expect(hook.lateWrites).toBe(0);
          expect(hook.lateSyncs).toBe(0);
          if (phase === "write") {
            const filename = path.join(directory, ".bigbud-thread-tools-managed.lock");
            expect((await lstat(filename)).isFile()).toBe(true);
            expect(JSON.parse(await readFile(filename, "utf8"))).toMatchObject({
              issuer: app.artifact.issuer,
              pid: process.pid,
            });
          }
          if (purpose === "record") expect(await records.read("owned")).toBeUndefined();
          if (purpose === "default") expect(registry.current()).toBe(v2ThreadImplementation("v1"));
        } finally {
          hook.target = "";
          hook.lose = () => {};
          await app.close();
        }
      }
  },
);
