import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";

import { app } from "electron";
import type {
  DesktopComputerUseInstallResult,
  DesktopComputerUsePermissionsStatus,
  DesktopComputerUseRuntimeSource,
  DesktopComputerUseRuntimeStatus,
} from "@bigbud/contracts";

import {
  checkComputerUsePermissions,
  missingComputerUsePermissionsStatus,
} from "./cuaDriver.permissions";

const CUA_DRIVER_VERSION = "0.6.8";
const CUA_DRIVER_INSTALLER_URL =
  "https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh";
const CUA_DRIVER_WINDOWS_INSTALLER_URL =
  "https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.ps1";

function binaryName(): string {
  return process.platform === "win32" ? "cua-driver.exe" : "cua-driver";
}

function resolveBundledBinaryPath(): string | null {
  if (!app.isPackaged) {
    return null;
  }

  const candidates = [
    process.platform === "darwin"
      ? Path.join(
          process.resourcesPath,
          "server",
          "cua-driver",
          "CuaDriver.app",
          "Contents",
          "MacOS",
          "cua-driver",
        )
      : null,
    Path.join(process.resourcesPath, "server", "cua-driver", "bin", binaryName()),
  ];

  for (const candidate of candidates) {
    if (candidate && FS.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveManagedPaths(baseDir: string) {
  const rootDir = Path.join(baseDir, "runtime", "cua-driver");
  const binDir = Path.join(rootDir, "bin");
  const homeDir = Path.join(rootDir, "home");
  return {
    rootDir,
    binDir,
    homeDir,
    binaryPath: Path.join(binDir, binaryName()),
  };
}

function resolveSystemBinaryPath(): string | null {
  const rawPath = process.env.PATH;
  if (!rawPath) {
    return null;
  }

  const directories = rawPath.split(Path.delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT")
          .split(";")
          .filter(Boolean)
          .map((value) => value.toLowerCase())
      : [""];
  const name = binaryName();

  for (const directory of directories) {
    if (process.platform === "win32") {
      const lowerName = name.toLowerCase();
      const hasExtension = extensions.some((extension) => lowerName.endsWith(extension));
      const candidates = hasExtension
        ? [Path.join(directory, name)]
        : extensions.map((extension) => Path.join(directory, `${name}${extension.toLowerCase()}`));

      for (const candidate of candidates) {
        if (FS.existsSync(candidate)) {
          return candidate;
        }
      }
      continue;
    }

    const candidate = Path.join(directory, name);
    if (FS.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveBinary(baseDir: string): {
  source: DesktopComputerUseRuntimeSource;
  binaryPath: string | null;
} {
  const bundledBinaryPath = resolveBundledBinaryPath();
  if (bundledBinaryPath) {
    return { source: "bundled", binaryPath: bundledBinaryPath };
  }

  const managedBinaryPath = resolveManagedPaths(baseDir).binaryPath;
  if (FS.existsSync(managedBinaryPath)) {
    return { source: "managed", binaryPath: managedBinaryPath };
  }

  const systemBinaryPath = resolveSystemBinaryPath();
  if (systemBinaryPath) {
    return { source: "system", binaryPath: systemBinaryPath };
  }

  return { source: "missing", binaryPath: null };
}

function runCommand(
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = ChildProcess.spawn(command, args, {
      env,
      stdio: "pipe",
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function readVersion(binaryPath: string): Promise<string | null> {
  try {
    const result = await runCommand(binaryPath, ["--version"]);
    const output = [result.stdout, result.stderr].filter(Boolean).join(" ").trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

function missingStatus(): DesktopComputerUseRuntimeStatus {
  return {
    available: false,
    source: "missing",
    binaryPath: null,
    version: null,
    message: "Computer Use runtime is not installed yet.",
    diagnostics: null,
  };
}

export async function getComputerUseRuntimeStatus(
  baseDir: string,
): Promise<DesktopComputerUseRuntimeStatus> {
  const runtime = resolveBinary(baseDir);
  if (!runtime.binaryPath || runtime.source === "missing") {
    return missingStatus();
  }

  return {
    available: true,
    source: runtime.source,
    binaryPath: runtime.binaryPath,
    version: await readVersion(runtime.binaryPath),
    message: null,
    diagnostics: null,
  };
}

export function resolveComputerUseRuntimeEnv(baseDir: string): NodeJS.ProcessEnv {
  const runtime = resolveBinary(baseDir);
  if (!runtime.binaryPath || runtime.source === "missing") {
    return {};
  }

  return { BIGBUD_CUA_DRIVER_PATH: runtime.binaryPath };
}

export async function installComputerUseRuntime(
  baseDir: string,
): Promise<DesktopComputerUseInstallResult> {
  const currentStatus = await getComputerUseRuntimeStatus(baseDir);
  if (currentStatus.available && currentStatus.source === "bundled") {
    return {
      ok: true,
      status: currentStatus,
    };
  }

  const managedPaths = resolveManagedPaths(baseDir);
  FS.mkdirSync(managedPaths.binDir, { recursive: true });
  FS.mkdirSync(managedPaths.homeDir, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CUA_DRIVER_RS_VERSION: CUA_DRIVER_VERSION,
    CUA_DRIVER_RS_INSTALL_DIR: managedPaths.binDir,
    CUA_DRIVER_RS_HOME: managedPaths.homeDir,
    CUA_DRIVER_RS_NO_MODIFY_PATH: "1",
  };

  const result =
    process.platform === "win32"
      ? await runCommand(
          "powershell.exe",
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            `irm ${CUA_DRIVER_WINDOWS_INSTALLER_URL} | iex`,
          ],
          env,
        )
      : await runCommand(
          "/bin/bash",
          [
            "-lc",
            `curl -fsSL ${CUA_DRIVER_INSTALLER_URL} | /bin/bash -s -- --backend=rust --bin-dir "${managedPaths.binDir}" --no-modify-path`,
          ],
          env,
        );

  const status = await getComputerUseRuntimeStatus(baseDir);
  return {
    ok: result.code === 0 && status.available,
    status: {
      ...status,
      message:
        result.code === 0
          ? status.message
          : [result.stderr, result.stdout].filter(Boolean).join("\n\n") ||
            "Computer Use runtime installation failed.",
    },
  };
}

export async function runComputerUseDoctor(
  baseDir: string,
): Promise<DesktopComputerUseRuntimeStatus> {
  const runtime = resolveBinary(baseDir);
  if (!runtime.binaryPath || runtime.source === "missing") {
    return missingStatus();
  }

  const result = await runCommand(runtime.binaryPath, ["doctor"]);
  return {
    available: true,
    source: runtime.source,
    binaryPath: runtime.binaryPath,
    version: await readVersion(runtime.binaryPath),
    message:
      result.code === 0
        ? "Computer Use diagnostics completed."
        : "Computer Use diagnostics reported issues.",
    diagnostics: [result.stdout, result.stderr].filter(Boolean).join("\n\n") || null,
  };
}

export async function getComputerUsePermissionsStatus(
  baseDir: string,
): Promise<DesktopComputerUsePermissionsStatus> {
  const runtime = resolveBinary(baseDir);
  if (!runtime.binaryPath || runtime.source === "missing") {
    return missingComputerUsePermissionsStatus(
      "Install the Computer Use runtime before checking desktop permissions.",
    );
  }

  return checkComputerUsePermissions({
    binaryPath: runtime.binaryPath,
    prompt: false,
  });
}

export async function requestComputerUsePermissions(
  baseDir: string,
): Promise<DesktopComputerUsePermissionsStatus> {
  const runtime = resolveBinary(baseDir);
  if (!runtime.binaryPath || runtime.source === "missing") {
    return missingComputerUsePermissionsStatus(
      "Install the Computer Use runtime before requesting desktop permissions.",
    );
  }

  return checkComputerUsePermissions({
    binaryPath: runtime.binaryPath,
    prompt: true,
  });
}
