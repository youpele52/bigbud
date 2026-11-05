import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import Path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireCopilotLease,
  activeCopilotLeases,
  withCopilotRuntimeLock,
} from "@bigbud/shared/copilotRuntime.storage";
import { installCopilotRuntime } from "./Runtime.install.ts";
import { uninstallCopilotRuntime, copilotSetupAcknowledged } from "./Runtime.lifecycle.ts";
import { readManagedCopilotRuntime } from "@bigbud/shared/copilotRuntime.paths";
import { runtimeFixture, archiveFetch } from "./Runtime.test.helpers.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function storage() {
  const root = await mkdtemp(Path.join(tmpdir(), "copilot-lifecycle-"));
  roots.push(root);
  return root;
}
async function install(root: string, version = "1.0.103") {
  const fixture = runtimeFixture({ version });
  return installCopilotRuntime({
    root,
    release: fixture.release,
    fetch: archiveFetch(fixture.bytes),
  });
}

describe("managed-only Copilot removal", () => {
  it("removes managed current/obsolete versions, preserves auth/settings/chats/external executable, and permits reinstall", async () => {
    const root = await storage();
    const external = await storage();
    await writeFile(Path.join(external, "copilot"), "external");
    for (const name of ["auth", "settings", "chats"]) await writeFile(Path.join(root, name), name);
    await install(root, "1.0.102");
    await install(root);
    await uninstallCopilotRuntime(root);
    expect(readManagedCopilotRuntime(root)).toBeUndefined();
    expect(await copilotSetupAcknowledged(root)).toBe(true);
    for (const name of ["auth", "settings", "chats"])
      expect(await readFile(Path.join(root, name), "utf8")).toBe(name);
    expect(await readFile(Path.join(external, "copilot"), "utf8")).toBe("external");
    await install(root);
    expect(readManagedCopilotRuntime(root)?.version).toBe("1.0.103");
  });

  it("blocks removal until session/probe/title leases have stopped", async () => {
    const root = await storage();
    await install(root);
    const release = await acquireCopilotLease(root);
    await expect(uninstallCopilotRuntime(root)).rejects.toThrow("Stop active");
    expect(readManagedCopilotRuntime(root)).toBeDefined();
    await release();
    await uninstallCopilotRuntime(root);
    expect(readManagedCopilotRuntime(root)).toBeUndefined();
  });

  it("does not block new Copilot leases for the duration of an update download", async () => {
    const root = await storage();
    const fixture = runtimeFixture();
    let finish: (() => void) | undefined;
    let started: (() => void) | undefined;
    const downloading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = installCopilotRuntime({
      root,
      release: fixture.release,
      fetch: async () => {
        started?.();
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return new Response(fixture.bytes);
      },
    });
    await downloading;
    const release = await acquireCopilotLease(root);
    expect(await withCopilotRuntimeLock(root, () => activeCopilotLeases(root))).toBe(1);
    finish?.();
    await pending;
    await release();
  });

  it("fails closed on unknown lease ownership and never follows managed symlinks", async () => {
    const root = await storage();
    const current = await install(root);
    await mkdir(Path.join(root, ".leases"), { recursive: true });
    await writeFile(Path.join(root, ".leases", "unknown"), "");
    await expect(uninstallCopilotRuntime(root)).rejects.toThrow("Unknown Copilot lease");
    await rm(Path.join(root, ".leases", "unknown"));
    const external = await storage();
    await writeFile(Path.join(external, "keep"), "safe");
    await symlink(external, Path.join(current.directory, "external"));
    await expect(uninstallCopilotRuntime(root)).rejects.toThrow("symlinks");
    expect(await readdir(external)).toEqual(["keep"]);
    expect(readManagedCopilotRuntime(root)).toBeDefined();
  });
});
