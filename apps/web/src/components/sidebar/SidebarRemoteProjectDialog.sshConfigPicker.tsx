import { ChevronDownIcon } from "lucide-react";
import { useMemo, useState } from "react";

import type { ServerSshConfigHost } from "@bigbud/contracts/server/server.sshConfig";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";
import { SearchableMenuList } from "../ui/SearchableMenuList";

export function sshConfigHostHint(host: ServerSshConfigHost): string {
  return [
    host.hostName,
    host.user ? `user ${host.user}` : null,
    host.port ? `port ${host.port}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function groupBySource(hosts: ReadonlyArray<ServerSshConfigHost>) {
  const groups = new Map<string, ServerSshConfigHost[]>();
  for (const host of hosts) {
    const group = groups.get(host.sourcePath);
    if (group) group.push(host);
    else groups.set(host.sourcePath, [host]);
  }
  return [...groups.entries()];
}

/** Dropdown host picker that mirrors the model picker: searchable, grouped by config file. */
export function SshConfigHostPicker({
  hosts,
  selected,
  invalid,
  onSelect,
}: {
  hosts: ReadonlyArray<ServerSshConfigHost>;
  selected: string;
  invalid: boolean;
  onSelect: (alias: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selectedHost = hosts.find((host) => host.alias === selected);
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? hosts.filter(
          (host) =>
            host.alias.toLowerCase().includes(needle) ||
            host.hostName?.toLowerCase().includes(needle) === true ||
            host.user?.toLowerCase().includes(needle) === true,
        )
      : hosts;
    return groupBySource(matches);
  }, [hosts, query]);

  return (
    <Menu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <MenuTrigger
        render={
          <Button
            variant="outline"
            aria-invalid={invalid ? true : undefined}
            aria-label={selected ? `SSH host: ${selected}` : "Choose an SSH host"}
            className="w-full min-w-0 justify-start overflow-hidden px-3 font-normal"
          />
        }
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <span className={selected ? "truncate" : "truncate text-muted-foreground"}>
            {selected || "Choose an SSH host"}
          </span>
          {selectedHost && sshConfigHostHint(selectedHost) ? (
            <span className="min-w-0 flex-1 truncate text-start text-muted-foreground text-xs">
              {sshConfigHostHint(selectedHost)}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        </span>
      </MenuTrigger>
      <MenuPopup align="start" className="w-(--anchor-width)">
        <SearchableMenuList query={query} onQueryChange={setQuery} placeholder="Search hosts">
          <MenuRadioGroup
            value={selected}
            onValueChange={(value) => {
              onSelect(String(value));
              setOpen(false);
            }}
          >
            {groups.map(([sourcePath, groupHosts]) => (
              <MenuGroup key={sourcePath}>
                <MenuGroupLabel>{sourcePath}</MenuGroupLabel>
                {groupHosts.map((host) => (
                  <MenuRadioItem key={host.alias} value={host.alias}>
                    <span className="block truncate">{host.alias}</span>
                    {sshConfigHostHint(host) ? (
                      <span className="block truncate text-muted-foreground text-xs">
                        {sshConfigHostHint(host)} · line {host.line}
                      </span>
                    ) : (
                      <span className="block text-muted-foreground text-xs">line {host.line}</span>
                    )}
                  </MenuRadioItem>
                ))}
              </MenuGroup>
            ))}
          </MenuRadioGroup>
          {groups.length === 0 ? (
            <div className="px-3 py-4 text-center text-sm text-muted-foreground/60">
              No hosts match “{query}”
            </div>
          ) : null}
        </SearchableMenuList>
      </MenuPopup>
    </Menu>
  );
}
