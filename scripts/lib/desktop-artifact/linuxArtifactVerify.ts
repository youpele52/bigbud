import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { get as httpGet } from "node:http";
import { homedir } from "node:os";

import { BIGBUD_LINUX_EXECUTABLE_NAME } from "@bigbud/shared/platform";
import { Effect, FileSystem, Path } from "effect";
import { ChildProcess } from "effect/unstable/process";

import { BuildScriptError, commandOutputOptions, runCommand } from "./shared.ts";
import { assertLinuxElectronRuntimeFiles } from "./linuxRuntimeFiles.ts";

/**
 * Find the Linux unpacked app directory inside the electron-builder output.
 * electron-builder names it something like "linux-unpacked" under the dist dir.
 */
export const findLinuxUnpackedApp = Effect.fn("findLinuxUnpackedApp")(function* (
  stageDistDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const entries = yield* fs.readDirectory(stageDistDir);
  for (const entry of entries) {
    if (entry.startsWith("linux-")) {
      const candidate = path.join(stageDistDir, entry);
      const stat = yield* fs.stat(candidate).pipe(Effect.catch(() => Effect.succeed(null)));
      if (stat && stat.type === "Directory") {
        return candidate;
      }
    }
  }

  return yield* new BuildScriptError({
    message: `No linux-unpacked app found in ${stageDistDir}`,
  });
});

/**
 * Find the built AppImage artifact in the output directory.
 */
export const findAppImageArtifact = Effect.fn("findAppImageArtifact")(function* (
  outputDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const entries = yield* fs.readDirectory(outputDir);
  for (const entry of entries) {
    if (entry.endsWith(".AppImage")) {
      return path.join(outputDir, entry);
    }
  }

  return yield* new BuildScriptError({
    message: `No .AppImage artifact found in ${outputDir}`,
  });
});

/**
 * Extract an AppImage to a temp directory using --appimage-extract.
 */
export const extractAppImage = Effect.fn("extractAppImage")(function* (
  appImagePath: string,
  tempDir: string,
  verbose: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* Effect.log(`[desktop-artifact] Extracting AppImage: ${appImagePath}`);

  yield* runCommand(
    ChildProcess.make({
      cwd: tempDir,
      ...commandOutputOptions(verbose),
      shell: true,
    })`${appImagePath} --appimage-extract`,
  );

  const squashfsRoot = path.join(tempDir, "squashfs-root");
  if (!(yield* fs.exists(squashfsRoot))) {
    return yield* new BuildScriptError({
      message: `AppImage extraction did not produce squashfs-root in ${tempDir}`,
    });
  }

  return squashfsRoot;
});

/**
 * Verify required runtime files exist in an unpacked Linux app directory.
 */
export const verifyLinuxUnpackedArtifact = Effect.fn("verifyLinuxUnpackedArtifact")(function* (
  unpackedDir: string,
) {
  yield* Effect.log(`[desktop-artifact] Verifying unpacked Linux artifact: ${unpackedDir}`);
  yield* assertLinuxElectronRuntimeFiles(
    unpackedDir,
    "Linux unpacked artifact verification failed",
  );
  yield* Effect.log("[desktop-artifact] Unpacked Linux artifact verification passed.");
});

/**
 * Extract an AppImage and verify required runtime files inside it.
 */
export const verifyLinuxAppImageArtifact = Effect.fn("verifyLinuxAppImageArtifact")(function* (
  appImagePath: string,
  verbose: boolean,
) {
  const fs = yield* FileSystem.FileSystem;

  yield* Effect.log(`[desktop-artifact] Verifying AppImage artifact: ${appImagePath}`);

  const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "bigbud-appimage-verify-" });
  const extractedRoot = yield* extractAppImage(appImagePath, tempDir, verbose);

  yield* assertLinuxElectronRuntimeFiles(extractedRoot, "AppImage artifact verification failed");

  yield* Effect.log("[desktop-artifact] AppImage artifact verification passed.");
});

/**
 * Smoke test a Linux AppImage by running it headlessly with --version.
 * This ensures the AppImage can actually start on the host system.
 *
 * Skipped in headless/CI environments where no X11/Wayland display is available.
 */
export const smokeTestLinuxAppImage = Effect.fn("smokeTestLinuxAppImage")(function* (
  appImagePath: string,
  verbose: boolean,
) {
  if (!process.env.DISPLAY) {
    yield* Effect.log(
      "[desktop-artifact] Skipping AppImage smoke test: no DISPLAY detected (headless environment).",
    );
    return;
  }

  yield* Effect.log(`[desktop-artifact] Smoke testing AppImage: ${appImagePath}`);

  yield* runCommand(
    ChildProcess.make({
      ...commandOutputOptions(verbose),
      shell: true,
    })`${appImagePath} --appimage-extract-and-run --no-sandbox --version`,
  );

  yield* Effect.log("[desktop-artifact] AppImage smoke test passed.");
});

async function findAvailableLoopbackPort(): Promise<number> {
  const { createServer } = await import("node:net");

  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to resolve an ephemeral loopback port."));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForPackagedBackendHttpReady(url: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpGet(url, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        request.setTimeout(1_000, () =>
          request.destroy(new Error("HTTP readiness check timed out.")),
        );
        request.once("error", reject);
      });

      if (status >= 200 && status < 300) {
        return;
      }
    } catch {
      // Backend is likely still starting; retry until timeout.
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Timed out waiting for packaged backend readiness at ${url}.`);
}

async function waitForChildExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve) => {
    let settled = false;

    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal });
    };

    const timeout = setTimeout(() => settle(child.exitCode, child.signalCode), timeoutMs);
    timeout.unref();
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      settle(code, signal);
    });
  });
}

async function terminateChildProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  const exited = await waitForChildExit(child, 2_000);
  if (exited.code === null && exited.signal === null) {
    child.kill("SIGKILL");
    await waitForChildExit(child, 1_000);
  }
}

function appendChunkTail(chunks: string[], value: string): void {
  chunks.push(value);
  while (chunks.join("").length > 4_096 && chunks.length > 1) {
    chunks.shift();
  }
}

async function waitForUnexpectedChildExit(options: {
  readonly child: ReturnType<typeof spawn>;
  readonly stdoutTail: string[];
  readonly stderrTail: string[];
}): Promise<never> {
  const { child, stderrTail, stdoutTail } = options;

  return await new Promise((_, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      reject(
        new Error(
          `Packaged backend exited before readiness check completed (code=${code ?? "null"} signal=${signal ?? "null"} stdout=${stdoutTail.join("").trim() || "<empty>"} stderr=${stderrTail.join("").trim() || "<empty>"})`,
        ),
      );
    });
  });
}

async function smokeTestExtractedLinuxBackendStartup(options: {
  readonly extractedRoot: string;
  readonly backendEntryPath: string;
  readonly launcherPath: string;
  readonly tempHomeDir: string;
}): Promise<void> {
  const port = await findAvailableLoopbackPort();
  const authToken = randomBytes(12).toString("hex");
  const readinessUrl = `http://127.0.0.1:${port}/`;
  const stderrTail: string[] = [];
  const stdoutTail: string[] = [];

  const child = spawn(options.launcherPath, [options.backendEntryPath, "--bootstrap-fd", "3"], {
    cwd: homedir(),
    env: {
      ...process.env,
      APPDIR: options.extractedRoot,
      BIGBUD_HOME: options.tempHomeDir,
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => appendChunkTail(stdoutTail, chunk));
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => appendChunkTail(stderrTail, chunk));

  try {
    const bootstrapStream = child.stdio[3];
    if (!bootstrapStream || !("write" in bootstrapStream)) {
      throw new Error("Missing bootstrap pipe on packaged backend process.");
    }

    bootstrapStream.write(
      `${JSON.stringify({
        mode: "desktop",
        host: "127.0.0.1",
        noBrowser: true,
        port,
        t3Home: options.tempHomeDir,
        authToken,
      })}\n`,
    );
    bootstrapStream.end();

    await Promise.race([
      waitForPackagedBackendHttpReady(readinessUrl, 15_000),
      waitForUnexpectedChildExit({ child, stdoutTail, stderrTail }),
    ]);
  } finally {
    await terminateChildProcess(child);
  }
}

export const smokeTestLinuxAppImageBackendStartup = Effect.fn(
  "smokeTestLinuxAppImageBackendStartup",
)(function* (appImagePath: string, verbose: boolean) {
  if (!process.env.DISPLAY) {
    yield* Effect.log(
      "[desktop-artifact] Skipping packaged backend startup smoke test: no DISPLAY detected (headless environment).",
    );
    return;
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* Effect.log(`[desktop-artifact] Smoke testing packaged backend startup: ${appImagePath}`);

  const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "bigbud-appimage-backend-smoke-" });
  const tempHomeDir = yield* fs.makeTempDirectoryScoped({ prefix: "bigbud-appimage-home-" });
  const extractedRoot = yield* extractAppImage(appImagePath, tempDir, verbose);
  const launcherPath = path.join(extractedRoot, BIGBUD_LINUX_EXECUTABLE_NAME);
  const backendEntryPath = path.join(extractedRoot, "resources", "server", "dist", "bin.mjs");

  if (!(yield* fs.exists(launcherPath))) {
    return yield* new BuildScriptError({
      message: `Packaged backend smoke test failed: launcher not found at ${launcherPath}`,
    });
  }

  if (!(yield* fs.exists(backendEntryPath))) {
    return yield* new BuildScriptError({
      message: `Packaged backend smoke test failed: backend entry not found at ${backendEntryPath}`,
    });
  }

  yield* Effect.tryPromise({
    try: () =>
      smokeTestExtractedLinuxBackendStartup({
        extractedRoot,
        backendEntryPath,
        launcherPath,
        tempHomeDir,
      }),
    catch: (cause) =>
      new BuildScriptError({
        message: `Packaged backend smoke test failed for ${appImagePath}`,
        cause,
      }),
  });

  yield* Effect.log("[desktop-artifact] Packaged backend startup smoke test passed.");
});
