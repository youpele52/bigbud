export const CUA_DRIVER_PRODUCTION_HOST_BUNDLE_ID = "ai.bigbud.desktop";
export const CUA_DRIVER_DEVELOPMENT_HOST_BUNDLE_ID = "ai.bigbud.desktop.dev";

export function resolveCuaDriverHostBundleId(isPackaged: boolean): string {
  return isPackaged ? CUA_DRIVER_PRODUCTION_HOST_BUNDLE_ID : CUA_DRIVER_DEVELOPMENT_HOST_BUNDLE_ID;
}
