import {
  type ProjectEntry,
  type ProviderKind,
  type ServerDiscoveredAgent,
  type ServerDiscoveredSkill,
} from "@bigbud/contracts";
import { memo, useLayoutEffect, useRef } from "react";
import { type ComposerTriggerKind } from "../../../logic/composer";
import { BookOpenIcon, BotIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Badge } from "../../ui/badge";
import {
  Command,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
} from "../../ui/command";
import { Searchbar } from "../../ui/Searchbar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { VscodeEntryIcon } from "../common/VscodeEntryIcon";

export type ComposerCommandItem =
  | {
      id: string;
      type: "path";
      path: string;
      pathKind: ProjectEntry["kind"];
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "slash-command";
      command: string;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "model";
      provider: ProviderKind;
      model: string;
      subProviderID?: string | undefined;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "agent";
      agent: ServerDiscoveredAgent;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "skill";
      skill: ServerDiscoveredSkill;
      label: string;
      description: string;
    };

export const ComposerCommandMenu = memo(function ComposerCommandMenu(props: {
  items: ComposerCommandItem[];
  resolvedTheme: "light" | "dark";
  isLoading: boolean;
  triggerKind: ComposerTriggerKind | null;
  discoverySearch: {
    command: "agents" | "skills" | "model";
    query: string;
    onQueryChange: (query: string) => void;
  } | null;
  activeItemId: string | null;
  onHighlightedItemChange: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const discoveryInputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (!props.activeItemId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-composer-item-id="${CSS.escape(props.activeItemId)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [props.activeItemId]);

  return (
    <Command
      autoHighlight={false}
      mode="none"
      onItemHighlighted={(highlightedValue) => {
        props.onHighlightedItemChange(
          typeof highlightedValue === "string" ? highlightedValue : null,
        );
      }}
    >
      <div
        ref={listRef}
        className="relative overflow-hidden rounded-xl border border-border/80 bg-popover/96 shadow-lg/8 backdrop-blur-xs"
      >
        {props.discoverySearch ? (
          <Searchbar
            sticky
            showSearchIcon={false}
            canClear={props.discoverySearch.query.length > 0}
            onClear={() => {
              props.discoverySearch?.onQueryChange("");
              discoveryInputRef.current?.focus();
            }}
            onClick={() => {
              discoveryInputRef.current?.focus();
            }}
          >
            <input
              ref={discoveryInputRef}
              type="text"
              value={props.discoverySearch.query}
              onChange={(event) => {
                props.discoverySearch?.onQueryChange(event.target.value);
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
              }}
              placeholder={
                props.discoverySearch.command === "agents"
                  ? "Search agents"
                  : props.discoverySearch.command === "skills"
                    ? "Search skills"
                    : "Search models"
              }
              className="min-w-0 flex-1 bg-transparent py-0.5 text-[11px] tracking-tight text-foreground placeholder:text-[11px] placeholder:tracking-tight placeholder:text-muted-foreground/50 focus:outline-none"
            />
          </Searchbar>
        ) : null}
        <CommandList className="max-h-96">
          {props.discoverySearch && props.items.length > 0 ? (
            <CommandGroup>
              <CommandGroupLabel>
                {props.discoverySearch.command === "agents"
                  ? "Agents"
                  : props.discoverySearch.command === "skills"
                    ? "Skills"
                    : "Models"}
              </CommandGroupLabel>
              {props.items.map((item) => (
                <ComposerCommandMenuItem
                  key={item.id}
                  item={item}
                  resolvedTheme={props.resolvedTheme}
                  isActive={props.activeItemId === item.id}
                  onHighlight={props.onHighlightedItemChange}
                  onSelect={props.onSelect}
                />
              ))}
            </CommandGroup>
          ) : (
            props.items.map((item) => (
              <ComposerCommandMenuItem
                key={item.id}
                item={item}
                resolvedTheme={props.resolvedTheme}
                isActive={props.activeItemId === item.id}
                onHighlight={props.onHighlightedItemChange}
                onSelect={props.onSelect}
              />
            ))
          )}
        </CommandList>
        {props.items.length === 0 && (
          <p className="px-3 py-2 text-muted-foreground/70 text-xs">
            {props.isLoading
              ? "Searching workspace files..."
              : props.triggerKind === "path"
                ? "No matching agents, files, or folders."
                : props.triggerKind === "skill"
                  ? "No matching skills."
                  : props.discoverySearch?.command === "agents"
                    ? "No matching agents."
                    : props.discoverySearch?.command === "skills"
                      ? "No matching skills."
                      : props.discoverySearch?.command === "model"
                        ? "No matching models."
                        : "No matching command."}
          </p>
        )}
      </div>
    </Command>
  );
});

const ComposerCommandMenuItem = memo(function ComposerCommandMenuItem(props: {
  item: ComposerCommandItem;
  resolvedTheme: "light" | "dark";
  isActive: boolean;
  onHighlight: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const itemBody = (
    <>
      {props.item.type === "path" ? (
        <VscodeEntryIcon
          pathValue={props.item.path}
          kind={props.item.pathKind}
          theme={props.resolvedTheme}
        />
      ) : null}
      {props.item.type === "slash-command" ? (
        props.item.command === "read" ? (
          <BookOpenIcon className="size-4 text-muted-foreground/80" />
        ) : (
          <BotIcon className="size-4 text-muted-foreground/80" />
        )
      ) : null}
      {props.item.type === "model" ? (
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
          model
        </Badge>
      ) : null}
      {props.item.type === "agent" ? (
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
          agent
        </Badge>
      ) : null}
      {props.item.type === "skill" ? (
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
          skill
        </Badge>
      ) : null}
      {props.item.type === "skill" || props.item.type === "agent" ? (
        <>
          <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
            <span className="truncate font-medium">{props.item.label}</span>
            <span className="shrink-0 text-muted-foreground/70 text-xs">
              {props.item.type === "skill" ? props.item.skill.provider : props.item.agent.provider}
            </span>
          </span>
          <span className="max-w-[36%] min-w-0 truncate text-muted-foreground/70 text-xs">
            {props.item.description}
          </span>
        </>
      ) : (
        <>
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            <span className="truncate">{props.item.label}</span>
          </span>
          <span className="truncate text-muted-foreground/70 text-xs">
            {props.item.description}
          </span>
        </>
      )}
    </>
  );

  const row = (
    <CommandItem
      value={props.item.id}
      data-composer-item-id={props.item.id}
      className={cn(
        "cursor-pointer select-none gap-2 hover:bg-transparent hover:text-inherit data-highlighted:bg-transparent data-highlighted:text-inherit",
        props.isActive && "bg-accent! text-accent-foreground!",
      )}
      onMouseMove={() => {
        if (!props.isActive) props.onHighlight(props.item.id);
      }}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onSelect(props.item);
      }}
    >
      {itemBody}
    </CommandItem>
  );

  if (props.item.type !== "skill" && props.item.type !== "agent") {
    return row;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-foreground">{props.item.label}</span>
            <span className="text-muted-foreground text-xs">
              {props.item.type === "skill" ? props.item.skill.provider : props.item.agent.provider}
            </span>
          </div>
          <div className="text-muted-foreground/90 text-xs">
            {props.item.description || "No description available."}
          </div>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
});
