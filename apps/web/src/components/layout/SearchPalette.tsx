import { type ThreadId, isBuiltInChatsProject } from "@bigbud/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquareIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "~/lib/utils";
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
  const showResultsPanel = normalizedQuery.length > 0;

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandDialogPopup
        aria-label="Search palette"
        className="mx-auto w-full max-w-[26rem] overflow-visible border-0 bg-transparent p-0 shadow-none before:hidden"
        viewportClassName="items-center justify-center"
        data-testid="search-palette"
      >
        <Command value={query} onValueChange={setQuery}>
          <div className="group rounded-[22px] p-px transition-colors duration-200">
            <div className="rounded-[20px] border border-border bg-card transition-colors duration-200 has-focus-visible:border-ring/45">
              <div
                className={cn(
                  "px-3 py-2 sm:px-4 sm:py-3",
                  !showResultsPanel && "[&_[data-slot=searchbar]]:border-b-0",
                )}
              >
                <CommandInput
                  placeholder="Search"
                  className="h-8 border-transparent! bg-transparent! px-0 text-sm placeholder:text-muted-foreground/65"
                />
              </div>

              {showResultsPanel ? (
                <CommandPanel className="max-h-[min(22rem,50vh)] rounded-t-none border-0 bg-transparent shadow-none [clip-path:none] before:hidden">
                  <CommandList className="px-2 pb-2 sm:px-3 sm:pb-3">
                    {!hasResults && normalizedQuery && (
                      <CommandEmpty className="px-4 py-8 text-center text-muted-foreground text-sm">
                        No matching results
                      </CommandEmpty>
                    )}

                    {hasMessageResults && (
                      <CommandGroup>
                        <CommandGroupLabel className="px-2 pb-1 text-muted-foreground/80 uppercase tracking-[0.08em]">
                          In this thread
                        </CommandGroupLabel>
                        {messageResults.map((result) => (
                          <CommandItem
                            key={result.id}
                            value={result.id}
                            className="min-h-11 rounded-xl px-3 py-2"
                            onSelect={() => handleSelectMessage(result.messageId)}
                            onClick={() => handleSelectMessage(result.messageId)}
                          >
                            <div className="mr-3 text-muted-foreground/70">
                              <MessageSquareIcon className="size-4" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-muted-foreground text-sm leading-6">
                                {(() => {
                                  const highlight = highlightMatch(result.snippet, query);
                                  return highlight.hasMatch ? (
                                    <>
                                      {highlight.before}
                                      <mark className="rounded-sm bg-primary/20 px-0.5 font-medium text-foreground">
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
                      <CommandGroup className={cn(hasMessageResults ? "mt-2" : undefined)}>
                        <CommandGroupLabel className="px-2 pb-1 text-muted-foreground/80 uppercase tracking-[0.08em]">
                          All threads
                        </CommandGroupLabel>
                        {threadResults.map((result) => (
                          <CommandItem
                            key={result.id}
                            value={result.id}
                            className="min-h-11 rounded-xl px-3 py-2"
                            onSelect={() => handleSelectThread(result.threadId)}
                            onClick={() => handleSelectThread(result.threadId)}
                          >
                            <div className="mr-3 text-muted-foreground/70">
                              <MessageSquareIcon className="size-4" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm">{result.title}</div>
                              <div className="truncate text-muted-foreground text-xs leading-5">
                                {result.projectName} &gt; {result.title}
                              </div>
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    )}
                  </CommandList>
                </CommandPanel>
              ) : null}
            </div>
          </div>
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
