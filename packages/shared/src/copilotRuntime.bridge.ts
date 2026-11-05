import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import Path from "node:path";
import {
  copilotRuntimeRoot,
  readManagedCopilotRuntime,
  readManagedCopilotVersion,
} from "./copilotRuntime.paths.ts";
import {
  publishCopilotRuntime,
  readRuntimeState,
  recoverCopilotStaging,
  withCopilotRuntimeLock,
  writeRuntimeState,
} from "./copilotRuntime.storage.ts";

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Bridge only: preserve the unmodified standalone package from this app's trusted Resources.
 * No PATH/configured executable is copied and no network is used. Slim artifacts are a no-op.
 */
export async function preserveBundledCopilotRuntime(input: {
  readonly resourcesPath: string;
  readonly root?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}): Promise<void> {
  const server = Path.join(input.resourcesPath, "server");
  const manifest = await readRuntimeState(server, "copilot-runtime.json");
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("format" in manifest) ||
    manifest.format !== "bigbud.copilot-runtime.v1" ||
    !("mode" in manifest) ||
    !["bridge", "slim"].includes(String(manifest.mode))
  )
    throw new Error("Missing or invalid packaged Copilot rollout manifest.");
  if (manifest.mode === "slim") return;
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const targetPrefix = platform === "linux" ? "linux(?:musl)?" : platform;
  if (!["darwin", "win32", "linux"].includes(platform) || !["arm64", "x64"].includes(arch))
    throw new Error("Unsupported Copilot bridge platform.");
  const targets =
    "targets" in manifest && Array.isArray(manifest.targets)
      ? manifest.targets.filter(
          (value): value is string =>
            typeof value === "string" && new RegExp(`^${targetPrefix}-${arch}$`).test(value),
        )
      : [];
  if (targets.length !== 1)
    throw new Error("Bridge artifact does not contain exactly one compatible Copilot runtime.");
  const target = targets[0]!;
  const root = input.root ?? copilotRuntimeRoot();
  if ((await readRuntimeState(root, ".bridge-preserved.json")) === true) return;
  await withCopilotRuntimeLock(
    root,
    async () => {
      if ((await readRuntimeState(root, ".bridge-preserved.json")) === true) return;
      const current = readManagedCopilotRuntime(root);
      if (
        current &&
        (current.target === target ||
          (platform === "darwin" && arch === "arm64" && current.target === "darwin-x64"))
      ) {
        await writeRuntimeState(root, ".bridge-preserved.json", true);
        await writeRuntimeState(root, ".onboarding.json", true);
        return;
      }
      const modules = Path.join(server, "_modules");
      const scope = Path.join(modules, "@github");
      const source = Path.join(scope, `copilot-${target}`);
      for (const directory of [modules, scope, source])
        if (!(await lstat(directory)).isDirectory())
          throw new Error("Refusing a symlinked bundled Copilot source.");
      const packageInfo = await lstat(Path.join(source, "package.json"));
      if (!packageInfo.isFile() || packageInfo.size > 16_384)
        throw new Error("Unsafe bundled Copilot metadata.");
      const metadata = JSON.parse(await readFile(Path.join(source, "package.json"), "utf8"));
      if (
        metadata.name !== `@github/copilot-${target}` ||
        typeof metadata.version !== "string" ||
        !/^\d+\.\d+\.\d+$/.test(metadata.version)
      )
        throw new Error("Invalid bundled Copilot package identity.");
      const relative = `${metadata.version}/${target}`;
      const members = [
        target.startsWith("win32") ? "copilot.exe" : "copilot",
        "package.json",
        "README.md",
        "LICENSE.md",
      ];
      const names = await readdir(source);
      if (names.length !== members.length || names.some((name) => !members.includes(name)))
        throw new Error(
          "Unsupported bundled Copilot package layout; refusing to omit notices or assets.",
        );
      const staging = Path.join(root, ".bridge-staging");
      await recoverCopilotStaging(staging);
      const temporary = Path.join(staging, `${process.pid}-${randomUUID()}`);
      await mkdir(Path.join(temporary, "package"), { recursive: true, mode: 0o700 });
      try {
        if (!readManagedCopilotVersion(root, relative)) {
          for (const name of members) {
            const from = Path.join(source, name);
            const to = Path.join(temporary, "package", name);
            const before = await lstat(from);
            if (!before.isFile() || before.size === 0)
              throw new Error("Incomplete or symlinked bundled Copilot package.");
            await copyFile(from, to);
            const file = await open(to, "r+");
            try {
              if (name.startsWith("copilot")) await file.chmod(0o755);
              await file.sync();
            } finally {
              await file.close();
            }
            if (
              (await lstat(to)).size !== before.size ||
              (await digest(from)) !== (await digest(to))
            )
              throw new Error("Bundled Copilot changed during preservation.");
          }
          const marker = await open(Path.join(temporary, ".bigbud-owned"), "wx", 0o600);
          try {
            await marker.writeFile(`bigbud.copilot.v1\n${relative}\n`);
            await marker.sync();
          } finally {
            await marker.close();
          }
          await publishCopilotRuntime(root, relative, temporary);
        } else await publishCopilotRuntime(root, relative);
        await writeRuntimeState(root, ".bridge-preserved.json", true);
        await writeRuntimeState(root, ".onboarding.json", true);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
    undefined,
    true,
  );
}
