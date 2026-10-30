import type { ProviderControlsSnapshot } from "@bigbud/contracts/server/providerControls";
import { Button } from "../../ui/button";

export function ProviderMcpControls({
  snapshot,
  pending,
  onRefresh,
  onReload,
}: {
  snapshot: ProviderControlsSnapshot | null;
  pending: boolean;
  onRefresh: () => void;
  onReload: () => void;
}) {
  const reason = snapshot?.mcpReload.reason ?? "Requires a current live session.";
  return (
    <section aria-label="Native MCP servers" className="space-y-2 border-t pt-3 text-sm">
      <h3 className="font-medium">Native configured MCP servers</h3>
      <p className="text-xs text-muted-foreground">
        Reload affects all configured MCP servers in this session’s app-server, not just one server.
        Configuration is not rewritten.
      </p>
      <p className="text-xs text-muted-foreground">
        These controls target the native MCP runtime, not bigbud’s orchestration service. Internal
        bridge connections may also be listed.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending || !snapshot?.mcpStatus.available}
          onClick={onRefresh}
        >
          Refresh MCP status
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || !snapshot?.mcpReload.available}
          title={reason}
          onClick={onReload}
        >
          Reload all MCP servers
        </Button>
      </div>
      {reason && <p className="text-xs text-muted-foreground">{reason}</p>}
      <p className="text-xs text-muted-foreground">
        {snapshot?.mcpTargeted.reason ?? "Targeted reconnect, toggle and replace are unavailable."}
      </p>
      {snapshot?.reloadState && (
        <p
          role="status"
          className={
            snapshot.reloadState === "completed"
              ? "text-blue-600 dark:text-blue-400"
              : snapshot.reloadState === "failed"
                ? "text-red-600 dark:text-red-400"
                : "text-amber-600 dark:text-amber-400"
          }
        >
          {snapshot.reloadState === "completed"
            ? "Reload all MCP servers acknowledged — inspect server readiness below."
            : `Reload all MCP servers: ${snapshot.reloadState}`}
        </p>
      )}
      {snapshot?.servers && (
        <ul aria-label="Last reported MCP status" className="space-y-1">
          {snapshot.servers.length === 0 && (
            <li className="text-xs text-muted-foreground">No configured servers reported.</li>
          )}
          {snapshot.servers.map((server) => (
            <li key={server.name} className="flex justify-between gap-3">
              <span className="truncate">{server.name}</span>
              <span
                className={`text-xs ${server.status === "connected" ? "text-green-600 dark:text-green-400" : server.status === "failed" ? "text-red-600 dark:text-red-400" : server.status === "needs-auth" ? "text-amber-600 dark:text-amber-400" : server.status === "pending" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground"}`}
              >
                {server.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
