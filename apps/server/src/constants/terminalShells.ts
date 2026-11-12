/** Enable only after profile lifecycle/platform and default-launch prerequisites pass.
 * Not a user setting or environment override: persisted preferences cannot bypass it.
 */
export const FRESH_WINDOWS_SHELL_DEFAULTS_QUALIFIED = false;

/** Local Unix defaults are independent of remote lifecycle and suggestion qualification. */
export const localShellDefaultsEnabled = (platform: NodeJS.Platform = process.platform): boolean =>
  platform === "darwin" || platform === "linux";
