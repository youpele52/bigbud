import { type ThreadId, isBuiltInChatsProject } from "@bigbud/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquareIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../../stores/main";
import { useSearchStore } from "../../stores/ui";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
} from "../ui/command";
import { normalizeQuery, getSnippet, highlightMatch } from "./SearchPalette.logic";

interface SearchPaletteProps {
  activeThreadId: ThreadId | null;
}

interface ThreadSearchResult {
  id: string;
  threadId: ThreadId;
  title: string;
  projectName: string;
  type: "thread";
}

interface MessageSearchResult {
  id: string;
  threadId: ThreadId;
  messageId: string;
  text: string;
  snippet: string;
  matchIndex: number;
  type: "message";
}

function SearchPaletteDialogContent({ activeThreadId }: SearchPaletteProps) {
  const navigate = useNavigate();
  const open = useSearchStore((store) => store.searchOpen);
  const setOpen = useSearchStore((store) => store.setSearchOpen);
  const projects = useStore(useShallow((store) => store.projects));
  const threads = useStore(useShallow((store) => store.threads));
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) {
      setQuery("");
    }
  }, [open]);

  const activeThread = useMemo(() => {
    return threads.find((t) => t.id === activeThreadId) ?? null;
  }, [threads, activeThreadId]);

  const normalizedQuery = normalizeQuery(query);

  const messageResults = useMemo<MessageSearchResult[]>(() => {
    if (!normalizedQuery || !activeThread) return [];

    const results: MessageSearchResult[] = [];
    for (const message of activeThread.messages) {
      const text = message.text ?? "";
      const lowerText = text.toLowerCase();
      const matchIndex = lowerText.indexOf(normalizedQuery);
      if (matchIndex !== -1) {
        results.push({
          id: `message:${message.id}`,
          threadId: activeThread.id,
          messageId: message.id,
          text,
          snippet: getSnippet(text, matchIndex),
          matchIndex,
          type: "message",
        });
      }
    }
    return results;
  }, [normalizedQuery, activeThread]);

  const threadResults = useMemo<ThreadSearchResult[]>(() => {
    if (!normalizedQuery) return [];

    return threads
      .filter((thread) => thread.archivedAt === null)
      .filter((thread) => {
        const title = thread.title.toLowerCase();
        return title.includes(normalizedQuery);
      })
      .map((thread) => {
        const project = projects.find((p) => p.id === thread.projectId);
        const projectName =
          project?.name ?? (isBuiltInChatsProject(thread.projectId) ? "Chats" : "Project");
        return {
          id: `thread:${thread.id}`,
          threadId: thread.id,
          title: thread.title,
          projectName,
          type: "thread",
        };
      });
  }, [normalizedQuery, threads, projects]);

  const handleSelectThread = (threadId: ThreadId) => {
    setOpen(false);
    void navigate({ to: "/$threadId", params: { threadId } });
  };

  const handleSelectMessage = (messageId: string) => {
    setOpen(false);
    // Scroll to message - the message element should have a data attribute or id
    const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
    if (messageElement) {
      messageElement.scrollIntoView({ behavior: "smooth", block: "center" });
      // Add a brief highlight effect
      messageElement.classList.add("bg-primary/10");
      setTimeout(() => {
        messageElement.classList.remove("bg-primary/10");
      }, 1500);
    }
  };

  const hasMessageResults = messageResults.length > 0;
  const hasThreadResults = threadResults.length > 0;
  const hasResults = hasMessageResults || hasThreadResults;

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandDialogPopup
        aria-label="Search palette"
        className="max-h-[min(24rem,60vh)] w-full max-w-md overflow-hidden p-0"
        viewportClassName="items-center justify-center"
        data-testid="search-palette"
      >
        <Command value={query} onValueChange={setQuery}>
          <CommandInput
            placeholder="Search"
            className="h-9 text-xs placeholder:text-muted-foreground/60"
          />
          <CommandPanel className="max-h-[min(18rem,45vh)]">
            <CommandList>
              {!hasResults && normalizedQuery && (
                <CommandEmpty className="py-6 text-center text-muted-foreground text-sm">
                  No matching results
                </CommandEmpty>
              )}
              {!normalizedQuery && (
                <CommandEmpty className="py-4 text-center text-muted-foreground text-xs">
                  Type to search
                </CommandEmpty>
              )}

              {hasMessageResults && (
                <CommandGroup>
                  <CommandGroupLabel>In this thread</CommandGroupLabel>
                  {messageResults.map((result) => (
                    <CommandItem
                      key={result.id}
                      value={result.id}
                      onSelect={() => handleSelectMessage(result.messageId)}
                      onClick={() => handleSelectMessage(result.messageId)}
                    >
                      <div className="mr-2 text-muted-foreground/80">
                        <MessageSquareIcon className="size-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-muted-foreground">
                          {(() => {
                            const highlight = highlightMatch(result.snippet, query);
                            return highlight.hasMatch ? (
                              <>
                                {highlight.before}
                                <mark className="rounded-sm bg-primary/20 px-0.5 font-medium">
                                  {highlight.match}
                                </mark>
                                {highlight.after}
                              </>
                            ) : (
                              result.snippet
                            );
                          })()}
                        </div>
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}

              {hasThreadResults && (
                <CommandGroup>
                  <CommandGroupLabel>All threads</CommandGroupLabel>
                  {threadResults.map((result) => (
                    <CommandItem
                      key={result.id}
                      value={result.id}
                      onSelect={() => handleSelectThread(result.threadId)}
                      onClick={() => handleSelectThread(result.threadId)}
                    >
                      <div className="mr-2 text-muted-foreground/80">
                        <MessageSquareIcon className="size-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">{result.title}</div>
                        <div className="truncate text-muted-foreground text-xs">
                          {result.projectName} &gt; {result.title}
                        </div>
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </CommandPanel>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}

export function SearchPalette({ activeThreadId }: SearchPaletteProps) {
  const open = useSearchStore((store) => store.searchOpen);

  // Only render when open (lazy mount pattern like CommandPalette)
  return open ? <SearchPaletteDialogContent activeThreadId={activeThreadId} /> : null;
}
