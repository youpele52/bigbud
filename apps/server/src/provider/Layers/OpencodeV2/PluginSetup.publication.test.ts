import { mkdir, readFile, writeFile, lstat, unlink, rename } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { publishV2ManagedPlugin } from "./PluginSetup.publication.ts";
import { v2ManagedPluginFilename } from "./PluginSetup.record.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import { exportV2ThreadArtifact } from "./Orchestration.artifact.ts";
import { deferred } from "./Test.fixtures.ts";

const variant = vi.hoisted(() => ({ upgrade: false }));
vi.mock("./Orchestration.plugin.ts", async (original) => {
  const renderer = await original<typeof import("./Orchestration.plugin.ts")>();
  return {
    ...renderer,
    renderV2ThreadPlugin: () =>
      renderer.renderV2ThreadPlugin() +
      (variant.upgrade ? "\n// Disposable managed-publication upgrade.\n" : ""),
  };
});

/** App signing state and native placement are independent disposable directories. */
async function fixture() {
  const app = await makeV2ThreadPluginFixture();
  const root = path.join(app.root, "native-config");
  await mkdir(root, { mode: 0o755 });
  const config = path.join(root, "opencode.jsonc");
  const bytes =
    '// user comments and trailing comma are never edited\n{"plugins":["unrelated"],"unknown":{"preserved":true},}\n';
  await writeFile(config, bytes, { mode: 0o644 });
  const controller = new AbortController();
  const authority = {
    signal: controller.signal,
    scopeKey: "explicit-expanded-ack",
    assertCurrent: () => controller.signal.throwIfAborted(),
  };
  const filename = path.join(root, "plugins", v2ManagedPluginFilename(app.artifact));
  const records = await V2ThreadRecords.open(
    app.artifact.root,
    "installations",
    app.artifact.privateKey,
    app.artifact.publicKey,
  );
  return {
    app,
    root,
    config,
    bytes,
    controller,
    authority,
    filename,
    records,
    key: JSON.stringify([root, v2ManagedPluginFilename(app.artifact)]),
  };
}

it("first publication is private/no-overwrite, concurrent compatible calls join, and repeated setup changes no native bytes/inode", async () => {
  const f = await fixture();
  try {
    await Promise.all(
      Array.from({ length: 10 }, () => publishV2ManagedPlugin(f.app.artifact, f.root, f.authority)),
    );
    const before = await lstat(f.filename);
    const content = await readFile(f.filename, "utf8");
    expect(before.mode & 0o077).toBe(0);
    expect(before.nlink).toBe(1);
    expect(content).toContain(f.app.artifact.entryUri);
    expect(content).not.toMatch(/Bearer|callbackToken|PRIVATE KEY/);
    await publishV2ManagedPlugin(f.app.artifact, f.root, f.authority);
    expect(await readFile(f.filename, "utf8")).toBe(content);
    expect((await lstat(f.filename)).ino).toBe(before.ino);
    expect((await lstat(f.filename)).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(f.config, "utf8")).toBe(f.bytes);
  } finally {
    await f.app.close();
  }
});

it("only the exact signed prior inode can be upgraded; a copied-byte successor and unknown collision remain untouched", async () => {
  const f = await fixture();
  try {
    await publishV2ManagedPlugin(f.app.artifact, f.root, f.authority);
    variant.upgrade = true;
    const upgrade = await exportV2ThreadArtifact(f.app.root);
    await publishV2ManagedPlugin(upgrade, f.root, f.authority);
    expect(await readFile(f.filename, "utf8")).toContain(upgrade.entryUri);
    const bytes = await readFile(f.filename);
    const replacement = path.join(path.dirname(f.filename), "replacement.pending");
    await writeFile(replacement, bytes, { mode: 0o600 });
    await unlink(f.filename);
    await rename(replacement, f.filename);
    await expect(publishV2ManagedPlugin(upgrade, f.root, f.authority)).rejects.toThrow(
      "content or file identity changed",
    );
    expect(await readFile(f.filename)).toEqual(bytes);
  } finally {
    variant.upgrade = false;
    await f.app.close();
  }
  const foreign = await fixture();
  try {
    await mkdir(path.dirname(foreign.filename));
    await writeFile(foreign.filename, "// unrelated user plugin", { mode: 0o600 });
    await expect(
      publishV2ManagedPlugin(foreign.app.artifact, foreign.root, foreign.authority),
    ).rejects.toThrow("installation record missing for this profile");
    expect(await readFile(foreign.filename, "utf8")).toBe("// unrelated user plugin");
  } finally {
    await foreign.app.close();
  }
});

it("explicit native removal and an absent uncertain publication never become automatic recreation", async () => {
  const f = await fixture();
  try {
    await publishV2ManagedPlugin(f.app.artifact, f.root, f.authority);
    await unlink(f.filename);
    await expect(publishV2ManagedPlugin(f.app.artifact, f.root, f.authority)).rejects.toThrow(
      "will not override native removal",
    );
    const saved = (await f.records.read(f.key))!;
    await f.records.replace(f.key, saved.revision, {
      ...(saved.value as object),
      phase: "publishing",
    });
    await expect(publishV2ManagedPlugin(f.app.artifact, f.root, f.authority)).rejects.toThrow(
      "publication is uncertain",
    );
    await expect(lstat(f.filename)).rejects.toThrow();
  } finally {
    await f.app.close();
  }
});

it("a signed interrupted publication with its exact native inode can reconcile read-only, while revoked authority writes nothing", async () => {
  const f = await fixture();
  try {
    await publishV2ManagedPlugin(f.app.artifact, f.root, f.authority);
    const original = await lstat(f.filename);
    const saved = (await f.records.read(f.key))!;
    await f.records.replace(f.key, saved.revision, {
      ...(saved.value as object),
      phase: "publishing",
    });
    await publishV2ManagedPlugin(f.app.artifact, f.root, f.authority);
    expect((await f.records.read(f.key))?.value).toMatchObject({ phase: "committed" });
    expect((await lstat(f.filename)).mtimeMs).toBe(original.mtimeMs);
    f.controller.abort();
    await expect(publishV2ManagedPlugin(f.app.artifact, f.root, f.authority)).rejects.toThrow();
    expect((await lstat(f.filename)).mtimeMs).toBe(original.mtimeMs);
    expect(await readFile(f.config, "utf8")).toBe(f.bytes);
  } finally {
    await f.app.close();
  }
});

it("a cancelled waiter detaches without cancelling compatible publication, while revocation during an await blocks all native writes", async () => {
  const f = await fixture();
  try {
    const gate = deferred<void>();
    const entered = deferred<void>();
    const artifact = {
      ...f.app.artifact,
      verify: async () => {
        entered.resolve();
        await gate.promise;
        await f.app.artifact.verify();
      },
    };
    const owner = publishV2ManagedPlugin(artifact, f.root, f.authority);
    await entered.promise;
    const cancelled = new AbortController();
    const waiter = publishV2ManagedPlugin(artifact, f.root, {
      ...f.authority,
      waiterSignal: cancelled.signal,
    });
    const detached = expect(waiter).rejects.toThrow("waiter cancelled");
    cancelled.abort();
    await detached;
    gate.resolve();
    await owner;
    expect(await readFile(f.filename, "utf8")).toContain(artifact.entryUri);
  } finally {
    await f.app.close();
  }
  const revoked = await fixture();
  try {
    const gate = deferred<void>();
    const entered = deferred<void>();
    const artifact = {
      ...revoked.app.artifact,
      verify: async () => {
        entered.resolve();
        await gate.promise;
      },
    };
    const pending = publishV2ManagedPlugin(artifact, revoked.root, revoked.authority);
    const rejected = expect(pending).rejects.toThrow();
    await entered.promise;
    revoked.controller.abort();
    gate.resolve();
    await rejected;
    await expect(lstat(path.dirname(revoked.filename))).rejects.toThrow();
    expect(await readFile(revoked.config, "utf8")).toBe(revoked.bytes);
  } finally {
    await revoked.app.close();
  }
});

it("live enrollment evidence defers even an owned upgrade and native entry write failure preserves the old config", async () => {
  const f = await fixture();
  try {
    await publishV2ManagedPlugin(f.app.artifact, f.root, f.authority);
    const previous = await readFile(f.filename, "utf8");
    const enrollments = await V2ThreadRecords.open(
      f.app.artifact.root,
      "enrollments",
      f.app.artifact.privateKey,
      f.app.artifact.publicKey,
    );
    const owner = f.app.bind("live-session", f.app.root);
    await enrollments.replace("live-session", undefined, {
      owner,
      digest: f.app.envelope("inspect").ownerDigest,
      state: "active",
      acknowledged: { revision: 1, expiry: Date.now() + 60000 },
      pending: null,
    });
    variant.upgrade = true;
    const upgrade = await exportV2ThreadArtifact(f.app.root);
    await expect(publishV2ManagedPlugin(upgrade, f.root, f.authority)).rejects.toThrow(
      "not durably physically settled",
    );
    expect(await readFile(f.filename, "utf8")).toBe(previous);
  } finally {
    variant.upgrade = false;
    await f.app.close();
  }
  const blocked = await fixture();
  try {
    await mkdir(path.dirname(blocked.filename), { mode: 0o700 });
    await mkdir(blocked.filename, { mode: 0o700 });
    await expect(
      publishV2ManagedPlugin(blocked.app.artifact, blocked.root, blocked.authority),
    ).rejects.toThrow();
    expect((await lstat(blocked.filename)).isDirectory()).toBe(true);
    expect(await readFile(blocked.config, "utf8")).toBe(blocked.bytes);
  } finally {
    await blocked.app.close();
  }
});
