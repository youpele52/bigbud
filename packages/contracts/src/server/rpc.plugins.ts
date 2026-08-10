import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { PluginCatalog, PluginCatalogItem, PluginError, PluginId } from "./plugins";

const PluginRevisionInput = Schema.Struct({ pluginId: PluginId, revision: Schema.String });

export const WsPluginsListCatalogRpc = Rpc.make("plugins.listCatalog", {
  success: PluginCatalog,
  error: PluginError,
});
export const WsPluginsGetRpc = Rpc.make("plugins.get", {
  payload: Schema.Struct({ pluginId: PluginId }),
  success: Schema.Struct({
    item: PluginCatalogItem,
    installation: Schema.optional(Schema.Unknown),
  }),
  error: PluginError,
});
export const WsPluginsRefreshCatalogRpc = Rpc.make("plugins.refreshCatalog", {
  success: PluginCatalog,
  error: PluginError,
});
export const WsPluginsInstallRpc = Rpc.make("plugins.install", {
  payload: PluginRevisionInput,
  success: PluginCatalog,
  error: PluginError,
});
export const WsPluginsUpdateRpc = Rpc.make("plugins.update", {
  payload: Schema.Struct({
    pluginId: PluginId,
    revision: Schema.String,
    targetRevision: Schema.String,
  }),
  success: PluginCatalog,
  error: PluginError,
});
export const WsPluginsUninstallRpc = Rpc.make("plugins.uninstall", {
  payload: Schema.Struct({ pluginId: PluginId, revision: Schema.String }),
  success: PluginCatalog,
  error: PluginError,
});
