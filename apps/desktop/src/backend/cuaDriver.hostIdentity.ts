export const CUA_DRIVER_DEVELOPMENT_HOST_BUNDLE_ID = "ai.bigbud.desktop.dev";

export function resolveCuaDriverHostBundleId(isPackaged: boolean, packagedAppId: string): string {
  return isPackaged ? packagedAppId : CUA_DRIVER_DEVELOPMENT_HOST_BUNDLE_ID;
}
