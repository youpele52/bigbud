import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import { SidebarRemoteAgentManualInstall } from "../sidebar/SidebarRemoteAgentManualInstall";
import { Button } from "../ui/button";
import type {
  RemoteAgentHostNotice,
  RemoteAgentNoticeTone,
} from "./RemoteAgentManagementSection.actions";
import {
  remoteAgentHostStatus,
  remoteAgentHostStatusLabel,
  type RemoteAgentHost,
} from "./RemoteAgentManagementSection.logic";

const NOTICE_TONE: Record<RemoteAgentNoticeTone, string> = {
  info: "text-info-foreground",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  error: "text-destructive-foreground",
};

export function RemoteAgentNotice({ notice }: { readonly notice: RemoteAgentHostNotice }) {
  return (
    <div
      role={notice.tone === "error" ? "alert" : "status"}
      className={cn("space-y-1 text-sm", NOTICE_TONE[notice.tone])}
    >
      <p>{notice.message}</p>
      {notice.details?.length ? (
        <ul className="list-disc space-y-0.5 pl-5 text-xs">
          {notice.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function HostAction(props: {
  readonly label: string;
  readonly busyLabel?: string;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly helper: string | null;
  readonly onClick: () => void;
}) {
  return (
    <div className="space-y-1">
      <Button disabled={props.disabled} variant="outline" onClick={props.onClick}>
        {props.busy && props.busyLabel ? props.busyLabel : props.label}
      </Button>
      {props.helper ? <p className="text-xs text-muted-foreground">{props.helper}</p> : null}
    </div>
  );
}

export interface RemoteAgentHostRowProps {
  readonly host: RemoteAgentHost;
  readonly removed: boolean;
  readonly installed: boolean;
  readonly busyAction: string | null;
  readonly anyBusy: boolean;
  readonly notice: RemoteAgentHostNotice | undefined;
  readonly onUpdate: () => void;
  readonly onReplaceNow: () => void;
  readonly onInstall: () => void;
  readonly onRemove: () => void;
  readonly onFinishInstall: () => void;
  readonly onSwitchToAgent: () => void;
}

/** One saved host. Disconnected hosts stay greyed with disabled actions; nothing opens SSH. */
export function RemoteAgentHostRow(props: RemoteAgentHostRowProps) {
  const { host } = props;
  const disabled = !host.connected || props.anyBusy;
  const helper = (text: string) => (host.connected ? text : null);
  const action = (
    key: string,
    label: string,
    helperText: string,
    onClick: () => void,
    busyLabel?: string,
  ): ReactNode => (
    <HostAction
      key={key}
      label={label}
      busy={props.busyAction === key}
      disabled={disabled}
      helper={helper(helperText)}
      onClick={onClick}
      {...(busyLabel ? { busyLabel } : {})}
    />
  );
  const status = remoteAgentHostStatus(host, props.removed);
  const agentPresent = host.transport === "agent" && !props.removed;
  const canInstallOnDirect = host.transport === "direct-ssh" && host.hasConnectedOverSsh;
  const actions: ReactNode[] = [];
  if (agentPresent) {
    actions.push(
      action(
        "update",
        "Update",
        "Downloads and verifies the newest agent. It is used the next time you choose Connect new session.",
        props.onUpdate,
        "Updating…",
      ),
      action(
        "replace",
        "Replace now",
        "Activates the newest verified agent now. Older versions are removed once nothing uses them.",
        props.onReplaceNow,
        "Replacing…",
      ),
    );
  } else if (host.transport === "agent" || (canInstallOnDirect && !props.installed)) {
    actions.push(
      action(
        "install",
        "Install agent",
        "Downloads, verifies and connects the agent in ~/.bigbud/agent on this host.",
        props.onInstall,
        "Installing…",
      ),
    );
  }
  if (canInstallOnDirect && props.installed) {
    actions.push(
      action(
        "switch",
        "Use the remote agent for workspaces on this host",
        "Saves each workspace on this host with the remote agent method.",
        props.onSwitchToAgent,
        "Switching…",
      ),
    );
  }
  if (agentPresent || canInstallOnDirect) {
    actions.push(
      action(
        "remove",
        "Remove agent",
        "Deletes ~/.bigbud/agent on this host and disconnects it. Live work blocks removal.",
        props.onRemove,
        "Removing…",
      ),
    );
  }
  return (
    <div
      className={cn("space-y-3 border-t p-4 first:border-t-0", !host.connected && "opacity-60")}
      data-connected={host.connected}
      data-testid="remote-agent-host"
    >
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{host.hostLabel}</p>
        <p className="text-xs text-muted-foreground">
          {host.transport === "agent" ? "Remote agent" : "Direct SSH"} ·{" "}
          {remoteAgentHostStatusLabel(status)} · {host.projects.length}{" "}
          {host.projects.length === 1 ? "workspace" : "workspaces"}
        </p>
      </div>
      {!host.connected ? <p className="text-xs text-muted-foreground">Connect to manage</p> : null}
      {host.transport === "direct-ssh" && host.connected && !host.hasConnectedOverSsh ? (
        <p className="text-xs text-muted-foreground">
          Connect over SSH first to install the agent.
        </p>
      ) : null}
      {actions.length > 0 ? (
        <div className="flex flex-wrap items-start gap-3">{actions}</div>
      ) : null}
      {agentPresent && host.connected ? (
        <div className="space-y-2">
          <SidebarRemoteAgentManualInstall
            executionTargetId={host.target}
            autoOpen={false}
            onOpenChange={() => {}}
          />
          {action(
            "finish",
            "Finish install",
            "After running the remote command on the host, choose Finish install.",
            props.onFinishInstall,
          )}
        </div>
      ) : null}
      {props.notice ? <RemoteAgentNotice notice={props.notice} /> : null}
    </div>
  );
}
