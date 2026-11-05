import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import Path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preserveBundledCopilotRuntime } from "./copilotRuntime.bridge.ts";
import { readManagedCopilotRuntime } from "./copilotRuntime.paths.ts";
import { readRuntimeState } from "./copilotRuntime.storage.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(mode = "bridge") {
  const base = await mkdtemp(Path.join(tmpdir(), "copilot-bridge-"));
  roots.push(base);
  const resourcesPath = Path.join(base, "resources");
  const platform = process.platform === "win32" ? ("win32" as const) : ("darwin" as const);
  const arch = "arm64";
  const target = `${platform}-${arch}`;
  const source = Path.join(resourcesPath, "server", "_modules", "@github", `copilot-${target}`);
  await mkdir(source, { recursive: true });
  const binary = platform === "win32" ? "copilot.exe" : "copilot";
  await writeFile(Path.join(source, binary), "bundled runtime bytes", { mode: 0o755 });
  await writeFile(
    Path.join(source, "package.json"),
    JSON.stringify({ name: `@github/copilot-${target}`, version: "1.0.102" }),
  );
  await writeFile(Path.join(source, "LICENSE.md"), "license unchanged");
  await writeFile(Path.join(source, "README.md"), "readme unchanged");
  await writeFile(
    Path.join(resourcesPath, "server", "copilot-runtime.json"),
    JSON.stringify({ format: "bigbud.copilot-runtime.v1", mode, targets: [target] }),
  );
  return {
    base,
    source,
    binary,
    root: Path.join(base, "managed"),
    input: { resourcesPath, root: Path.join(base, "managed"), platform, arch },
  };
}

describe("approved Copilot bridge preservation", () => {
  it("silently preserves exact executable/license bytes outside Resources without downloading", async () => {
    const f = await fixture();
    const fetch = vi.spyOn(globalThis, "fetch");
    await preserveBundledCopilotRuntime(f.input);
    const installed = readManagedCopilotRuntime(f.root)!;
    expect(installed.version).toBe("1.0.102");
    expect(await readFile(installed.path, "utf8")).toBe("bundled runtime bytes");
    expect(await readFile(Path.join(installed.directory, "package", "LICENSE.md"), "utf8")).toBe(
      "license unchanged",
    );
    expect(await readRuntimeState(f.root, ".onboarding.json")).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(await readdir(f.source)).toHaveLength(4);
  });
  it("is idempotent and does not resurrect copies intentionally removed after preservation", async () => {
    const f = await fixture();
    await preserveBundledCopilotRuntime(f.input);
    const installed = readManagedCopilotRuntime(f.root)!;
    await writeFile(Path.join(f.source, f.binary), "changed newer bundle");
    await preserveBundledCopilotRuntime(f.input);
    expect(await readFile(installed.path, "utf8")).toBe("bundled runtime bytes");
    await rm(installed.directory, { recursive: true });
    await rm(Path.join(f.root, "current"));
    await preserveBundledCopilotRuntime(f.input);
    expect(readManagedCopilotRuntime(f.root)).toBeUndefined();
    expect(await readRuntimeState(f.root, ".onboarding.json")).toBe(true);
  });
  it("recovers interrupted private staging and coordinates concurrent bridge starts", async () => {
    const f = await fixture();
    const stale = Path.join(f.root, ".bridge-staging", `99999999-${randomUUID()}`);
    await mkdir(stale, { recursive: true });
    await writeFile(Path.join(stale, "partial"), "partial");
    await Promise.all([
      preserveBundledCopilotRuntime(f.input),
      preserveBundledCopilotRuntime(f.input),
    ]);
    expect(await readdir(Path.join(f.root, ".bridge-staging"))).toEqual([]);
    expect(readManagedCopilotRuntime(f.root)).toBeDefined();
  });
  it("does nothing for slim artifacts, including users who skipped the bridge", async () => {
    const f = await fixture("slim");
    await rm(f.source, { recursive: true });
    await preserveBundledCopilotRuntime(f.input);
    expect(readManagedCopilotRuntime(f.root)).toBeUndefined();
    expect(await readdir(f.base)).toEqual(["resources"]);
  });
  it("retains the bundled source and leaves no published pointer on failure", async () => {
    const f = await fixture();
    await rm(Path.join(f.source, "LICENSE.md"));
    await expect(preserveBundledCopilotRuntime(f.input)).rejects.toThrow("layout");
    expect(readManagedCopilotRuntime(f.root)).toBeUndefined();
    expect(await readFile(Path.join(f.source, f.binary), "utf8")).toBe("bundled runtime bytes");
  });
  it("rejects symlinked package members instead of claiming external files", async () => {
    const f = await fixture();
    await rm(Path.join(f.source, "LICENSE.md"));
    await symlink(Path.join(f.source, "README.md"), Path.join(f.source, "LICENSE.md"));
    await expect(preserveBundledCopilotRuntime(f.input)).rejects.toThrow("symlinked");
    expect(readManagedCopilotRuntime(f.root)).toBeUndefined();
    expect(await readFile(Path.join(f.source, "README.md"), "utf8")).toBe("readme unchanged");
  });
  it("does not overwrite an existing current installation or silently downgrade it", async () => {
    const f = await fixture();
    await preserveBundledCopilotRuntime(f.input);
    const installed = readManagedCopilotRuntime(f.root)!;
    await rm(Path.join(f.root, ".bridge-preserved.json"));
    await writeFile(
      Path.join(f.source, "package.json"),
      JSON.stringify({ name: `@github/copilot-${installed.target}`, version: "1.0.101" }),
    );
    await preserveBundledCopilotRuntime(f.input);
    expect(readManagedCopilotRuntime(f.root)?.version).toBe("1.0.102");
  });
});
