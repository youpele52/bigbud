import { spawn } from "node:child_process";
import { lstat, realpath, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { assertV2WorkspaceStorageSeparate } from "./Runtime.workspaceBoundary.ts";
import type { V2CodingFileResult } from "./Coding.files.ts";
import { inspectV2CommandWorkspace } from "./Execution.workspace.ts";
const literal = (value: string) => JSON.stringify(value);

/** Kernel-enforced local command boundary. macOS deliberately denies fork: no detached descendants to guess dead. */
export function v2SeatbeltProfile(root: string, temporary: string, profile: string) {
  return `(version 1)(deny default)
    (allow process-exec)
    (allow mach-lookup (global-name "com.apple.system.logger"))
    (allow file-read-metadata)
    (allow file-read* (literal "/"))
    (allow file-read* (subpath "/usr/bin") (subpath "/usr/lib") (subpath "/usr/share") (subpath "/bin") (subpath "/System/Library") (subpath "/System/Volumes/Preboot/Cryptexes/OS") (subpath "/Library/Developer") (subpath "/Library/Frameworks") (subpath "/Library/Apple"))
    (allow file-read* file-write* (literal "/dev/null") (literal "/dev/urandom") (subpath ${literal(root)}) (subpath ${literal(temporary)}))
    (deny file-read* file-write* (subpath ${literal(profile)}))
    ${[".git", ".opencode", ".agents", ".bigbud"].map((name) => `(deny file-write* (regex ${literal(`(^|/)${name.replaceAll(".", "\\.")}(/|$)`)}))`).join("\n")}
    (deny network* process-fork file-link)`;
}

/** Explicit exact command approval is required by caller; no environment inheritance, shell/native tool fallback or installation. */
export async function runV2ContainedShell(input: {
  root: string;
  profile: string;
  command: string;
  beforeSpawn: () => Promise<() => void>;
  signal?: AbortSignal;
}): Promise<V2CodingFileResult> {
  if (process.platform !== "darwin")
    throw new Error(
      "V2 contained shell currently requires the verified macOS Seatbelt launcher; no unrestricted fallback.",
    );
  if (!input.command.trim() || Buffer.byteLength(input.command) > 16384)
    throw new Error("V2 command exceeds bound or is empty.");
  const root = await realpath(input.root),
    profile = await realpath(input.profile);
  await assertV2WorkspaceStorageSeparate(profile, root);
  const pinned = await lstat(root);
  if (!pinned.isDirectory() || pinned.isSymbolicLink())
    throw new Error("V2 command root rejected.");
  await inspectV2CommandWorkspace(root, profile);
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "bigbud-v2-exec-")));
  try {
    const current = await lstat(root);
    if (
      current.dev !== pinned.dev ||
      current.ino !== pinned.ino ||
      (await realpath(input.root)) !== root
    )
      throw new Error("V2 command workspace identity changed.");
    const validate = await input.beforeSpawn();
    validate();
    input.signal?.throwIfAborted();
    const child = spawn(
      "/usr/bin/sandbox-exec",
      ["-p", v2SeatbeltProfile(root, temporary, profile), "/bin/sh", "-c", input.command],
      {
        cwd: root,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin", HOME: temporary, TMPDIR: temporary, LANG: "en_US.UTF-8" },
      },
    );
    let stopped = false,
      kill: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      child.kill("SIGTERM");
      kill = setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const timeout = setTimeout(stop, 30000);
    input.signal?.addEventListener("abort", stop, { once: true });
    try {
      return await new Promise<V2CodingFileResult>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let bytes = 0,
          error: Error | undefined;
        child.once("error", (cause) => {
          error = cause;
        });
        const output = (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 131072) {
            error = new Error("V2 command output exceeded bound.");
            stop();
          } else chunks.push(chunk);
        };
        child.stdout.on("data", output);
        child.stderr.on("data", output);
        child.once("close", (code, signal) => {
          if (error) reject(error);
          else
            resolve({
              content: JSON.stringify({
                exitCode: code,
                signal,
                cancelled: stopped,
                outputBase64: Buffer.concat(chunks).toString("base64"),
                containment: "seatbelt-no-fork-no-network",
              }),
            });
        });
      });
    } finally {
      clearTimeout(timeout);
      clearTimeout(kill);
      input.signal?.removeEventListener("abort", stop);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
