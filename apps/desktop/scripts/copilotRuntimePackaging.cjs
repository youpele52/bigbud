const fs = require("node:fs");
const path = require("node:path");

const FORMAT = "bigbud.copilot-runtime.v1";

function resolveCopilotPackagingMode(environment = process.env) {
  const mode = environment.BIGBUD_COPILOT_RUNTIME_MODE ?? "bridge";
  if (mode !== "bridge" && mode !== "slim")
    throw new Error("BIGBUD_COPILOT_RUNTIME_MODE must be bridge or slim.");
  return mode;
}

function copilotPackagingTargets(platform, arch) {
  const os = { mac: "darwin", linux: "linux", win: "win32" }[platform];
  if (
    !os ||
    !["arm64", "x64", "universal"].includes(arch) ||
    (arch === "universal" && os !== "darwin")
  )
    throw new Error("Unsupported Copilot packaging target.");
  return (arch === "universal" ? ["arm64", "x64"] : [arch]).map((cpu) => `${os}-${cpu}`);
}

function excluded(name, mode, targets = []) {
  return (
    name.startsWith("copilot-sdk-") ||
    (mode === "slim" &&
      (name === "copilot" || (name.startsWith("copilot-") && name !== "copilot-sdk"))) ||
    (mode === "bridge" &&
      targets.length > 0 &&
      /^copilot-(darwin|linux|linuxmusl|win32)-/.test(name) &&
      !targets.includes(name.slice("copilot-".length)))
  );
}

function excludedBin(name, mode, targets) {
  if (!/^copilot(?:-|\.|$)/i.test(name)) return false;
  if (mode === "slim") return true;
  const base = name.replace(/\.(cmd|ps1|exe)$/i, "");
  return (
    base !== "copilot" &&
    (!/^copilot-(darwin|win32|linux|linuxmusl)-(arm64|x64)$/.test(base) ||
      (targets.length > 0 && !targets.includes(base.slice("copilot-".length))))
  );
}

/** Visit every nested installed scope, never following staging symlinks outside the tree. */
function visitScopes(directory, action, binAction) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (path.basename(directory) === "@github") action(entry.name, child);
    if (path.basename(directory) === ".bin") binAction?.(entry.name, child);
    if (entry.isDirectory() && fs.existsSync(child)) visitScopes(child, action, binAction);
  }
}

function pruneCopilotRuntimePackages(modulesDirectory, mode, targets = []) {
  if (!["bridge", "slim"].includes(mode)) throw new Error("Invalid Copilot packaging mode.");
  const removed = [];
  visitScopes(
    modulesDirectory,
    (name, child) => {
      if (excluded(name, mode, targets)) {
        fs.rmSync(child, { recursive: true, force: true });
        removed.push(child);
      }
    },
    (name, child) => {
      if (excludedBin(name, mode, targets)) {
        fs.rmSync(child, { recursive: true, force: true });
        removed.push(child);
      }
    },
  );
  return removed;
}

function writeCopilotPackagingManifest(serverDirectory, mode, targets) {
  if (
    !["bridge", "slim"].includes(mode) ||
    !targets.length ||
    targets.some((target) => !/^(darwin|win32|linux)-(arm64|x64)$/.test(target))
  )
    throw new Error("Invalid Copilot rollout manifest.");
  fs.writeFileSync(
    path.join(serverDirectory, "copilot-runtime.json"),
    JSON.stringify({ format: FORMAT, mode, targets }) + "\n",
  );
}

/** Used both before electron-builder and on its final packaged Resources/server directory. */
function assertCopilotRuntimePackaging(serverDirectory) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(serverDirectory, "copilot-runtime.json"), "utf8"),
  );
  if (
    manifest.format !== FORMAT ||
    !["bridge", "slim"].includes(manifest.mode) ||
    !Array.isArray(manifest.targets) ||
    !manifest.targets.length ||
    manifest.targets.some((target) => !/^(darwin|win32|linux)-(arm64|x64)$/.test(target))
  )
    throw new Error("Invalid packaged Copilot rollout manifest.");
  const modules = fs.existsSync(path.join(serverDirectory, "_modules"))
    ? path.join(serverDirectory, "_modules")
    : path.join(serverDirectory, "node_modules");
  visitScopes(
    modules,
    (name, child) => {
      if (excluded(name, manifest.mode, manifest.targets))
        throw new Error(`Forbidden bundled Copilot runtime: ${child}`);
    },
    (name, child) => {
      if (excludedBin(name, manifest.mode, manifest.targets))
        throw new Error(`Forbidden bundled Copilot executable: ${child}`);
    },
  );
  if (!fs.existsSync(path.join(modules, "@github", "copilot-sdk", "package.json")))
    throw new Error("Packaged lightweight Copilot SDK is missing.");
  if (manifest.mode === "bridge") {
    if (!fs.existsSync(path.join(modules, "@github", "copilot", "package.json")))
      throw new Error("Bridge artifact must retain the standalone Copilot launcher.");
    for (const target of manifest.targets) {
      const directory = path.join(modules, "@github", `copilot-${target}`);
      const expected = [
        target.startsWith("win32") ? "copilot.exe" : "copilot",
        "package.json",
        "README.md",
        "LICENSE.md",
      ];
      const names = fs.readdirSync(directory);
      if (names.length !== expected.length || names.some((name) => !expected.includes(name)))
        throw new Error("Unsupported bridge Copilot package layout.");
      for (const file of [
        target.startsWith("win32") ? "copilot.exe" : "copilot",
        "package.json",
        "README.md",
        "LICENSE.md",
      ]) {
        const info = fs.lstatSync(path.join(directory, file));
        if (!info.isFile() || !info.size)
          throw new Error(`Bridge artifact is missing required Copilot package file: ${file}`);
      }
    }
  }
  return manifest;
}

module.exports = {
  resolveCopilotPackagingMode,
  copilotPackagingTargets,
  pruneCopilotRuntimePackages,
  writeCopilotPackagingManifest,
  assertCopilotRuntimePackaging,
};
