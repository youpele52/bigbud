import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { V2_FILE_WORKER } from "./Coding.files.worker.ts";
import { assertV2WorkspaceStorageSeparate } from "./Runtime.workspaceBoundary.ts";

export interface V2CodingFileAction {
  readonly action: "read" | "list" | "write" | "edit" | "skill" | "check" | "probe" | "inspect";
  readonly path: string;
  readonly content?: string;
  readonly expectedSha256?: string | null;
}
export interface V2CodingFileResult {
  readonly content?: string;
  readonly sha256?: string;
  readonly entries?: string[];
}

export interface V2CodingTarget {
  readonly root: string;
  readonly executionTargetId?: string;
  run(
    action: V2CodingFileAction,
    beforeSpawn?: () => Promise<() => void>,
  ): Promise<V2CodingFileResult>;
}

/** Optional Unix stdlib helper: fail closed, never install tools or fall back to pathname-only mutations. */
export async function resolveV2FilePython(profile: string): Promise<string> {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("V2 descriptor coding currently requires Unix and Python 3.");
  for (const filename of [
    "/usr/bin/python3",
    "/usr/local/bin/python3",
    "/opt/homebrew/bin/python3",
  ]) {
    try {
      const candidate = await realpath(filename);
      if (candidate.startsWith(`${profile}${path.sep}`)) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Only an existing compatible executable is eligible. */
    }
  }
  throw new Error(
    "V2 descriptor coding requires an existing Python 3 executable; no unsafe builtin fallback.",
  );
}

/** Root identity is captured before actions; child traversal uses openat/no-follow directory descriptors. */
export class V2CodingFiles {
  private constructor(
    readonly root: string,
    readonly profile: string,
    readonly python: string,
    readonly identity: readonly number[],
  ) {}
  static async open(root: string, profile: string, python: string) {
    const canonical = await realpath(root);
    await assertV2WorkspaceStorageSeparate(profile, canonical);
    const info = await lstat(canonical);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(canonical)) !== canonical)
      throw new Error("V2 coding root changed.");
    const files = new V2CodingFiles(canonical, profile, python, [info.dev, info.ino]);
    await files.run({ action: "list", path: "." });
    return files;
  }
  async run(
    action: V2CodingFileAction,
    beforeSpawn?: () => Promise<() => void>,
  ): Promise<V2CodingFileResult> {
    await assertV2WorkspaceStorageSeparate(this.profile, this.root);
    const input = JSON.stringify({ ...action, root: this.root, identity: this.identity });
    if (Buffer.byteLength(input) > 1_000_000) throw new Error("V2 coding input exceeds bound.");
    const validate = await beforeSpawn?.();
    validate?.();
    return new Promise((resolve, reject) => {
      const child = spawn(this.python, ["-I", "-S", "-c", V2_FILE_WORKER], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      });
      let output = "",
        settled = false;
      const finish = (error?: Error, result?: V2CodingFileResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result!);
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 10_000);
      child.on("error", (error) => finish(error));
      child.stdin.on("error", () => {});
      child.stdout.on("data", (data) => {
        output += String(data);
        if (Buffer.byteLength(output) > 1_000_000) child.kill("SIGKILL");
      });
      child.stderr.resume();
      child.on("close", (code) => {
        try {
          if (code !== 0)
            throw new Error(
              "V2 file action failed or outcome unconfirmed; never automatically retry writes.",
            );
          const reply = JSON.parse(output) as {
            ok: boolean;
            result?: V2CodingFileResult;
            error?: string;
          };
          if (!reply.ok) throw new Error(reply.error ?? "V2 file action rejected.");
          finish(undefined, reply.result);
        } catch (error) {
          finish(error instanceof Error ? error : new Error("V2 file result invalid."));
        }
      });
      child.stdin.end(input);
    });
  }
}
