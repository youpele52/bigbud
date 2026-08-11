import type { WsRpcContext } from "./wsRpcContext";

export const makeWsRpcPluginHandlers = (context: WsRpcContext) => ({
  "plugins.listCatalog": () => context.pluginRegistry.listCatalog,
  "plugins.get": ({ pluginId }: { readonly pluginId: string }) =>
    context.pluginRegistry.get(pluginId),
  "plugins.refreshCatalog": () => context.pluginRegistry.refresh,
  "plugins.install": ({
    pluginId,
    revision,
  }: {
    readonly pluginId: string;
    readonly revision: string;
  }) => context.pluginRegistry.install({ pluginId, revision }),
  "plugins.update": ({
    pluginId,
    revision,
    targetRevision,
  }: {
    readonly pluginId: string;
    readonly revision: string;
    readonly targetRevision: string;
  }) => context.pluginRegistry.update({ pluginId, revision, targetRevision }),
  "plugins.uninstall": ({
    pluginId,
    revision,
  }: {
    readonly pluginId: string;
    readonly revision: string;
  }) => context.pluginRegistry.uninstall({ pluginId, revision }),
});
