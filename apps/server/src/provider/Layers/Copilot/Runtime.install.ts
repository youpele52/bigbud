import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import Path from "node:path";

import {
  withCopilotRuntimeLock,
  publishCopilotRuntime,
  recoverCopilotStaging,
} from "@bigbud/shared/copilotRuntime.storage";

import { extractCopilotRuntime } from "./Runtime.archive.ts";
import {
  downloadCopilotRuntime,
  type CopilotRuntimeFetch,
  type CopilotRuntimeProgress,
} from "./Runtime.download.ts";
import {
  copilotRuntimeRoot,
  readManagedCopilotVersion,
  type ManagedCopilotRuntime,
} from "@bigbud/shared/copilotRuntime.paths";
import type { CopilotRuntimeRelease } from "./Runtime.release.ts";

async function requireDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) {
    throw new Error(`Refusing symlinked or non-directory Copilot runtime storage: ${directory}`);
  }
}

async function writeDurable(path: string, value: string): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(value, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

/**
 * Installs a trusted pinned release side by side. Never deletes published versions, external
 * executables, settings, or credentials. Callers must not accept release metadata from clients.
 * Publication uses the same short transaction lock as leases and managed-only uninstall.
 */
export async function installCopilotRuntime(input: {
  readonly release: CopilotRuntimeRelease;
  readonly root?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: CopilotRuntimeProgress) => void;
  readonly fetch?: CopilotRuntimeFetch;
}): Promise<ManagedCopilotRuntime> {
  const root = input.root ?? copilotRuntimeRoot();
  const relative = `${input.release.version}/${input.release.target}`;
  if (!/^\d+\.\d+\.\d+\/(darwin|linux|linuxmusl|win32)-(arm64|x64)$/.test(relative)) {
    throw new Error("Invalid Copilot runtime version or target.");
  }
  input.signal?.throwIfAborted();
  await requireDirectory(root);
  return withCopilotRuntimeLock(
    root,
    async () => {
      input.signal?.throwIfAborted();
      const staging = Path.join(root, ".staging");
      await requireDirectory(staging);
      await recoverCopilotStaging(staging);
      const temporary = Path.join(staging, `${process.pid}-${randomUUID()}`);
      await mkdir(temporary, { mode: 0o700 });
      try {
        let installed = readManagedCopilotVersion(root, relative);
        let staged: string | undefined;
        let downloadedBytes = 0;
        if (!installed) {
          const archive = Path.join(temporary, "runtime.tgz");
          await downloadCopilotRuntime({
            release: input.release,
            destination: archive,
            ...(input.signal ? { signal: input.signal } : {}),
            ...(input.fetch ? { fetch: input.fetch } : {}),
            ...(input.onProgress ? { onProgress: input.onProgress } : {}),
          });
          downloadedBytes = input.release.archiveBytes;
          // Cancellation is supported during download, never during publication.
          input.signal?.throwIfAborted();
          input.onProgress?.({
            phase: "installing",
            transferredBytes: input.release.archiveBytes,
            totalBytes: input.release.archiveBytes,
          });
          const extracted = Path.join(temporary, "extracted");
          await mkdir(extracted, { mode: 0o700 });
          await extractCopilotRuntime({ archive, destination: extracted, release: input.release });
          await writeDurable(
            Path.join(extracted, ".bigbud-owned"),
            `bigbud.copilot.v1\n${relative}\n`,
          );
          staged = extracted;
        }
        installed = await publishCopilotRuntime(root, relative, staged);
        input.onProgress?.({
          phase: "installed",
          transferredBytes: downloadedBytes,
          totalBytes: downloadedBytes,
        });
        return installed;
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
    input.signal,
    true,
  );
}
