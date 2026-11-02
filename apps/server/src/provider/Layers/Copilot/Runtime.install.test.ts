import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import Path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { installCopilotRuntime } from "./Runtime.install.ts";
import { readManagedCopilotRuntime } from "@bigbud/shared/copilotRuntime.paths";
import { archiveFetch, runtimeFixture } from "./Runtime.test.helpers.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function storage() {
  const root = await mkdtemp(Path.join(tmpdir(), "bigbud-copilot-install-"));
  roots.push(root);
  return root;
}

describe("managed Copilot runtime installer", () => {
  it("verifies, stages, publishes, reports real archive bytes, and retains license/notices", async () => {
    const root = await storage();
    const fixture = runtimeFixture();
    const progress = vi.fn();
    const installed = await installCopilotRuntime({
      root,
      release: fixture.release,
      fetch: archiveFetch(fixture.bytes),
      onProgress: progress,
    });
    expect(readManagedCopilotRuntime(root)).toEqual(installed);
    expect(await readFile(Path.join(installed.directory, "package", "LICENSE.md"), "utf8")).toBe(
      "License retained",
    );
    expect(await readFile(Path.join(installed.directory, "package", "README.md"), "utf8")).toBe(
      "Readme retained",
    );
    expect(progress.mock.calls.map(([value]) => value.phase)).toEqual([
      "downloading",
      "downloading",
      "verifying",
      "installing",
      "installed",
    ]);
    expect(progress.mock.lastCall?.[0]).toEqual({
      phase: "installed",
      transferredBytes: fixture.bytes.length,
      totalBytes: fixture.bytes.length,
    });
    expect(await readdir(Path.join(root, ".staging"))).toEqual([]);
  });

  it("coordinates concurrent installers and avoids re-downloading an owned version", async () => {
    const root = await storage();
    const fixture = runtimeFixture();
    const fetch = vi.fn(archiveFetch(fixture.bytes));
    const [first, second] = await Promise.all([
      installCopilotRuntime({ root, release: fixture.release, fetch }),
      installCopilotRuntime({ root, release: fixture.release, fetch }),
    ]);
    expect(first).toEqual(second);
    expect(fetch).toHaveBeenCalledTimes(1);
    const onProgress = vi.fn();
    await installCopilotRuntime({ root, release: fixture.release, fetch, onProgress });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onProgress.mock.lastCall?.[0]).toEqual({
      phase: "installed",
      transferredBytes: 0,
      totalBytes: 0,
    });
  });

  it("coordinates independent processes without duplicate downloads or partial publication", async () => {
    const root = await storage();
    const worker = fileURLToPath(new URL("./Runtime.install.test.worker.ts", import.meta.url));
    await Promise.all(
      [0, 1].map(() => promisify(execFile)(process.execPath, [worker, root], { timeout: 15_000 })),
    );
    expect(await readFile(Path.join(root, "downloads"), "utf8")).toBe("download\n");
    expect(readManagedCopilotRuntime(root)?.version).toBe("1.0.103");
    expect(await readdir(Path.join(root, ".staging"))).toEqual([]);
  });

  it("publishes updates side by side, preserving the old executable and rollback version", async () => {
    const root = await storage();
    const old = runtimeFixture({ version: "1.0.102" });
    const next = runtimeFixture();
    const previous = await installCopilotRuntime({
      root,
      release: old.release,
      fetch: archiveFetch(old.bytes),
    });
    const before = await readFile(previous.path);
    const current = await installCopilotRuntime({
      root,
      release: next.release,
      fetch: archiveFetch(next.bytes),
    });
    expect(readManagedCopilotRuntime(root)?.path).toBe(current.path);
    expect(await readFile(previous.path)).toEqual(before);
    expect(previous.directory).not.toBe(current.directory);
  });

  it("preserves current runtime, auth, settings, and chats on verification failure", async () => {
    const root = await storage();
    const old = runtimeFixture({ version: "1.0.102" });
    const previous = await installCopilotRuntime({
      root,
      release: old.release,
      fetch: archiveFetch(old.bytes),
    });
    for (const name of ["auth", "settings", "chats"]) await writeFile(Path.join(root, name), name);
    const bad = runtimeFixture();
    const corrupted = Buffer.from(bad.bytes);
    corrupted[0] = corrupted[0]! ^ 1;
    await expect(
      installCopilotRuntime({ root, release: bad.release, fetch: archiveFetch(corrupted) }),
    ).rejects.toThrow("checksum mismatch");
    expect(readManagedCopilotRuntime(root)).toEqual(previous);
    for (const name of ["auth", "settings", "chats"])
      expect(await readFile(Path.join(root, name), "utf8")).toBe(name);
    expect(await readdir(Path.join(root, ".staging"))).toEqual([]);
  });

  it("recovers recognized interrupted staging only, then installs successfully", async () => {
    const root = await storage();
    const abandoned = Path.join(root, ".staging", `99999999-${randomUUID()}`);
    await mkdir(abandoned, { recursive: true });
    await writeFile(Path.join(abandoned, "runtime.tgz"), "partial");
    const fixture = runtimeFixture();
    await installCopilotRuntime({
      root,
      release: fixture.release,
      fetch: archiveFetch(fixture.bytes),
    });
    expect(await readdir(Path.join(root, ".staging"))).toEqual([]);
  });

  it("refuses unrecognized staging rather than deleting arbitrary data", async () => {
    const root = await storage();
    await mkdir(Path.join(root, ".staging", "user-data"), { recursive: true });
    const fixture = runtimeFixture();
    await expect(
      installCopilotRuntime({ root, release: fixture.release, fetch: archiveFetch(fixture.bytes) }),
    ).rejects.toThrow("refusing automatic cleanup");
    expect(await readdir(Path.join(root, ".staging"))).toEqual(["user-data"]);
  });

  it("refuses symlinked storage and version directories without modifying their target", async () => {
    const root = await storage();
    const external = await storage();
    await writeFile(Path.join(external, "keep"), "external");
    const fixture = runtimeFixture();
    const link = Path.join(root, "linked");
    await symlink(external, link);
    await expect(
      installCopilotRuntime({
        root: link,
        release: fixture.release,
        fetch: archiveFetch(fixture.bytes),
      }),
    ).rejects.toThrow("Refusing symlinked");
    await symlink(external, Path.join(root, fixture.release.version));
    await expect(
      installCopilotRuntime({ root, release: fixture.release, fetch: archiveFetch(fixture.bytes) }),
    ).rejects.toThrow("Refusing symlinked");
    expect(await readdir(external)).toEqual(["keep"]);
  });

  it("does not download or publish after caller cancellation", async () => {
    const root = await storage();
    const fixture = runtimeFixture();
    const controller = new AbortController();
    const fetch = vi.fn(archiveFetch(fixture.bytes));
    controller.abort();
    await expect(
      installCopilotRuntime({ root, release: fixture.release, fetch, signal: controller.signal }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(readManagedCopilotRuntime(root)).toBeUndefined();
  });
});
