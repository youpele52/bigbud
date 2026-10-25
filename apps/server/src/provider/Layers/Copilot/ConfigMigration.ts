import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  readProviderConfig,
  writeProviderConfig,
  withProviderConfigMigration,
} from "../../providerConfigMigration.ts";

// User settings documented by Copilot 1.0.103; never copy authentication/internal state.
const settingKeys = new Set([
  "allowedUrls",
  "askUser",
  "autoTier",
  "autoUpdate",
  "autoUpdatesChannel",
  "banner",
  "bannerStyle",
  "bashEnv",
  "beep",
  "beepOnSchedule",
  "colorMode",
  "commandHistoryMaxSize",
  "compactPaste",
  "companyAnnouncements",
  "connectors",
  "contextTier",
  "continueOnAutoMode",
  "copyOnSelect",
  "customAgents",
  "defaultMode",
  "defaultPermissionMode",
  "deniedUrls",
  "disableAllHooks",
  "disabledMcpServers",
  "disabledSkills",
  "dynamicRetrieval",
  "editorMode",
  "effortLevel",
  "enabledMcpServers",
  "enabledPlugins",
  "experimental",
  "extraKnownMarketplaces",
  "footer",
  "hooks",
  "ide",
  "ignoredSkillsLocations",
  "includeCoAuthoredBy",
  "inlineImages",
  "inlineImageLiveWindow",
  "keepAlive",
  "logLevel",
  "memory",
  "mergeStrategy",
  "model",
  "mouse",
  "notifications",
  "permissions",
  "pinnedPrompts",
  "powershellFlags",
  "proxyKerberosServicePrincipal",
  "proxyUrl",
  "remoteExport",
  "remoteSessions",
  "renderHexColors",
  "renderMarkdown",
  "respectGitignore",
  "sandbox",
  "screenReader",
  "scrollbar",
  "shellShortcut",
  "showReasoning",
  "showTimestamps",
  "showTipsOnStartup",
  "sidebar",
  "skillDirectories",
  "statusLine",
  "stayInAutopilot",
  "storeTokenPlaintext",
  "stream",
  "streamerMode",
  "subagents",
  "tabs",
  "taskbarPresence",
  "terminalNotifications",
  "terminalProgress",
  "theme",
  "toolSearch",
  "transcriptView",
  "updateTerminalTitle",
  "worktreeBaseRef",
  "worktreePathTemplate",
]);

/** Copy legacy settings once; retain legacy state and never resurrect later deleted preferences. */
export async function migrateBundledCopilotConfig(env: NodeJS.ProcessEnv = process.env) {
  const directory = resolve(env.COPILOT_HOME || join(homedir(), ".copilot"));
  return withProviderConfigMigration(directory, async () => {
    const marker = join(directory, ".bigbud-settings-migration-1.json");
    if (await readProviderConfig(marker)) return;
    const legacy = await readProviderConfig(join(directory, "config.json"));
    if (!legacy) return;
    const path = join(directory, "settings.json");
    const destination = await readProviderConfig(path);
    const settings = { ...destination?.value };
    for (const [key, value] of Object.entries(legacy.value)) {
      if (settingKeys.has(key) && !Object.hasOwn(settings, key)) settings[key] = value;
    }
    if (Object.keys(settings).length > 0) await writeProviderConfig(path, destination, settings);
    await writeProviderConfig(marker, undefined, { version: 1 });
  });
}
