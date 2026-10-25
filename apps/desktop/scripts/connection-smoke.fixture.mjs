import { mkdir, mkdtemp, realpath, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute, sep } from "node:path";

const providerNames = [
  "codex",
  "claudeAgent",
  "cliProxy",
  "copilot",
  "kilocode",
  "opencode",
  "opencodeV2",
  "pi",
  "cursor",
  "devin",
];

async function removeOwnedAlias(aliasRoot, runtimeHome) {
  if (!aliasRoot) return;
  try {
    await unlink(runtimeHome);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await rmdir(aliasRoot);
}

async function prepareFixtureState(state, workspace) {
  await mkdir(join(state, "userdata"), { recursive: true });
  await writeFile(
    join(state, "userdata", "settings.json"),
    JSON.stringify({
      defaultChatCwd: workspace,
      providers: Object.fromEntries(providerNames.map((name) => [name, { enabled: false }])),
      computerUseEnabled: false,
      hasSeenComputerUsePrompt: true,
      threadRetentionPolicy: "never",
      enableThinkingStreaming: false,
    }),
    { mode: 0o600 },
  );
}

/** Isolates both the Chromium profile and backend state, with all providers disabled. */
export async function createConnectionSmokeFixture() {
  const parent = process.env.BIGBUD_CONNECTION_SMOKE_TEMP_DIR ?? tmpdir();
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "bigbud-connection-smoke-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });

  // Darwin's Unix socket paths are short. Keep data in the requested directory,
  // but use a disposable short alias for HOME and the native sidecar endpoints.
  const aliasRoot = process.platform === "darwin" ? await mkdtemp("/tmp/bbcs-") : null;
  const runtimeHome = aliasRoot ? join(aliasRoot, "h") : home;
  const state = join(runtimeHome, "b");
  try {
    if (aliasRoot) await symlink(home, runtimeHome, "dir");
    await prepareFixtureState(state, workspace);
  } catch (error) {
    try {
      await removeOwnedAlias(aliasRoot, runtimeHome);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Smoke fixture setup and alias cleanup failed.",
        { cause: error },
      );
    }
    throw error;
  }

  // Do not inherit provider credentials, SSH agents, native-service overrides,
  // NODE_OPTIONS, or real profile paths from the invoking developer shell.
  const environment = {};
  for (const key of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TMP",
    "TEMP",
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  Object.assign(environment, {
    HOME: runtimeHome,
    USERPROFILE: runtimeHome,
    APPDATA: join(runtimeHome, "appdata"),
    LOCALAPPDATA: join(runtimeHome, "local-appdata"),
    XDG_CONFIG_HOME: join(runtimeHome, ".config"),
    BIGBUD_HOME: state,
    BIGBUD_DISABLE_AUTO_UPDATE: "1",
  });
  if (process.platform !== "win32") environment.SHELL = "/bin/sh";

  return {
    root,
    home,
    workspace,
    environment,
    async assertProfileIsIsolated(profilePath) {
      const resolvedHome = await realpath(home);
      const resolvedProfile = await realpath(profilePath);
      const within = relative(resolvedHome, resolvedProfile);
      if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
        throw new Error("Packaged application did not use its isolated smoke-test profile.");
      }
    },
    async releaseAlias() {
      await removeOwnedAlias(aliasRoot, runtimeHome);
    },
  };
}

/** Avoid publishing even the fixture's authenticated socket URLs in failures. */
export function sanitizeConnectionSmokeError(error) {
  const message = error instanceof Error ? error.message : "Unknown smoke-test failure";
  return message.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/giu, "[redacted endpoint]");
}
