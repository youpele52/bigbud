import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { RefreshIconButton } from "../ui/RefreshIconButton";
import {
  hasRemoteProjectConnectionOverrides,
  type RemoteProjectDraft,
  type UpdateRemoteProjectDraft,
} from "./Sidebar.projects.logic";
import {
  FieldError,
  RemoteProjectAuthenticationFields,
  remoteProjectInputClassName,
  type RemoteProjectFieldErrors,
} from "./SidebarRemoteProjectDialog.options";
import type { SshConfigHostsState } from "./SidebarRemoteProjectDialog.sshConfigHosts";
import { SshConfigHostPicker } from "./SidebarRemoteProjectDialog.sshConfigPicker";

interface SshConfigFieldsProps {
  draft: RemoteProjectDraft;
  fieldErrors: RemoteProjectFieldErrors;
  hosts: SshConfigHostsState & { readonly refresh: () => void };
  onFieldChange: UpdateRemoteProjectDraft;
  onUseManual: () => void;
}

export function SidebarRemoteProjectSshConfigHostField({
  draft,
  fieldErrors,
  hosts,
  onFieldChange,
  onUseManual,
}: SshConfigFieldsProps) {
  const result = hosts.status === "ready" ? hosts.result : null;
  const selected = draft.host.trim();
  const selectedIsKnown = result?.hosts.some((host) => host.alias === selected) ?? false;
  const sourceIssues = result?.sources.filter(
    (source) => source.status === "error" || source.status === "skipped",
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground">SSH host</span>
        <RefreshIconButton
          label="Reload SSH config"
          busy={hosts.status === "loading"}
          onClick={hosts.refresh}
        />
      </div>

      {hosts.status === "loading" || hosts.status === "idle" ? (
        <p className="text-muted-foreground text-xs">Reading SSH config…</p>
      ) : null}
      {hosts.status === "error" ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-destructive text-xs leading-4">
          <span className="min-w-0 flex-1">{hosts.message}</span>
          <Button variant="outline" size="xs" onClick={hosts.refresh}>
            Retry
          </Button>
          <Button variant="outline" size="xs" onClick={onUseManual}>
            Enter manually
          </Button>
        </div>
      ) : null}
      {result && result.hosts.length === 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/24 px-3 py-2 text-muted-foreground text-xs leading-4">
          <span className="min-w-0 flex-1">
            No hosts found in the SSH config on {result.machineName}.
          </span>
          <Button variant="outline" size="xs" onClick={onUseManual}>
            Enter manually
          </Button>
        </div>
      ) : null}
      {result && result.hosts.length > 0 ? (
        <SshConfigHostPicker
          hosts={result.hosts}
          selected={selected}
          invalid={Boolean(fieldErrors.host)}
          onSelect={(alias) => onFieldChange("host", alias)}
        />
      ) : null}
      {result ? (
        <p className="text-muted-foreground text-xs leading-4">
          Read from the SSH config on {result.machineName}. bigbud saves only the host name locally,
          so later config changes still apply.
        </p>
      ) : null}
      {sourceIssues && sourceIssues.length > 0 ? (
        <ul className="space-y-0.5 text-amber-700 text-xs leading-4 dark:text-amber-300">
          {sourceIssues.map((source) => (
            <li key={`${source.path}:${source.message ?? source.status}`}>
              {source.path}: {source.message ?? source.status}
            </li>
          ))}
        </ul>
      ) : null}
      {selected && result && !selectedIsKnown ? (
        <p className="text-amber-700 text-xs leading-4 dark:text-amber-300">
          {selected} isn't in the SSH config; bigbud will still pass it to ssh.
        </p>
      ) : null}
      <FieldError message={fieldErrors.host} />
    </div>
  );
}

/** Overrides for an SSH config host; shown after the shared connection options. */
export function SidebarRemoteProjectSshConfigAdvanced({
  draft,
  fieldErrors,
  onFieldChange,
}: Pick<SshConfigFieldsProps, "draft" | "fieldErrors" | "onFieldChange">) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Overrides are never hidden: Advanced stays open while any is set.
  const showAdvanced = advancedOpen || hasRemoteProjectConnectionOverrides(draft);

  return (
    <Collapsible open={showAdvanced} onOpenChange={setAdvancedOpen}>
      <CollapsibleTrigger className="flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground">
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3.5 transition-transform", showAdvanced && "rotate-90")}
        />
        Advanced: override username, port, or authentication
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="space-y-4 pt-3">
          <p className="text-muted-foreground text-xs leading-4">
            Leave these blank to use what your SSH config sets for this host.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <label htmlFor="remote-project-config-username" className="block">
              <span className="text-xs font-medium text-foreground">Username</span>
              <Input
                id="remote-project-config-username"
                className={remoteProjectInputClassName}
                placeholder="From SSH config"
                spellCheck={false}
                value={draft.username}
                onChange={(event) => onFieldChange("username", event.target.value)}
              />
            </label>
            <label htmlFor="remote-project-config-port" className="block">
              <span className="text-xs font-medium text-foreground">Port</span>
              <Input
                id="remote-project-config-port"
                aria-invalid={fieldErrors.port ? true : undefined}
                className={`${remoteProjectInputClassName} max-w-48`}
                inputMode="numeric"
                placeholder="From SSH config"
                spellCheck={false}
                value={draft.port}
                onChange={(event) => onFieldChange("port", event.target.value)}
              />
              <FieldError message={fieldErrors.port} />
            </label>
          </div>
          <RemoteProjectAuthenticationFields draft={draft} onFieldChange={onFieldChange} />
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
