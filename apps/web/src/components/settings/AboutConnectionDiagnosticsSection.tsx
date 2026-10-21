import { useQuery } from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";

import { ensureNativeApi } from "../../rpc/nativeApi";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  buildConnectionTransitionRows,
  CONNECTION_TRANSITION_LIMIT,
  type ConnectionTransitionRow,
  describeEventLoopWindow,
} from "./AboutConnectionDiagnosticsSection.logic";

const CONNECTION_DIAGNOSTICS_QUERY_KEY = ["ws-connection-diagnostics"] as const;

const TONE_BADGE_VARIANT = {
  info: "info",
  success: "success",
  warning: "warning",
  error: "error",
} as const;

function ConnectionTransitionItem({ row }: { row: ConnectionTransitionRow }) {
  return (
    <li className="flex flex-col gap-0.5 py-2 first:pt-0 last:pb-0">
      <div className="flex items-center gap-2">
        <Badge variant={TONE_BADGE_VARIANT[row.tone]} size="sm">
          {row.source === "server" ? "Server" : "App"}
        </Badge>
        <span className="text-sm text-foreground">{row.label}</span>
        <time className="ml-auto shrink-0 text-xs text-muted-foreground" dateTime={row.at}>
          {new Date(row.atMs).toLocaleTimeString()}
        </time>
      </div>
      {row.details.length > 0 ? (
        <span className="break-all text-xs text-muted-foreground">{row.details.join(" · ")}</span>
      ) : null}
    </li>
  );
}

export function AboutConnectionDiagnosticsSection() {
  const query = useQuery({
    queryKey: CONNECTION_DIAGNOSTICS_QUERY_KEY,
    queryFn: async () => {
      const read = ensureNativeApi().server.getWsConnectionDiagnostics;
      return read ? read({ limit: CONNECTION_TRANSITION_LIMIT }) : null;
    },
    staleTime: 5_000,
    refetchInterval: 10_000,
  });
  const snapshot = query.data ?? null;
  const rows = snapshot ? buildConnectionTransitionRows(snapshot) : [];
  const unavailable = query.isSuccess && snapshot === null;

  return (
    <SettingsSection
      title="Connection"
      headerAction={
        <Button
          size="xs"
          variant="ghost"
          className="gap-1"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCwIcon className="size-3 shrink-0" aria-hidden="true" />
          Refresh
        </Button>
      }
    >
      <SettingsRow
        title="Server responsiveness"
        description="How long the local server's event loop was blocked recently."
        status={
          <span className="block text-xs text-muted-foreground">
            {unavailable
              ? "Not available in this build."
              : query.isError
                ? "Could not read connection diagnostics."
                : describeEventLoopWindow(snapshot?.eventLoop ?? null)}
          </span>
        }
      />
      <SettingsRow
        title="Recent transitions"
        description={`The last ${CONNECTION_TRANSITION_LIMIT} connection changes seen by the app and the server.`}
        searchTerms={["disconnect", "reconnect", "stall", "websocket"]}
      >
        {rows.length > 0 ? (
          <ul className="mt-3 flex flex-col divide-y divide-border">
            {rows.map((row) => (
              <ConnectionTransitionItem key={row.id} row={row} />
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">
            {query.isPending
              ? "Loading..."
              : "No connection changes recorded since the server started."}
          </p>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}
