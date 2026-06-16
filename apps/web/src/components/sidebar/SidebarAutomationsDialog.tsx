import { PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type AutomationId, type ThreadId } from "@bigbud/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ensureNativeApi } from "~/rpc/nativeApi";
import { useThreadById } from "~/stores/main/global-selectors.store";
import { toastManager } from "~/components/ui/toast";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";

interface SidebarAutomationsDialogProps {
  open: boolean;
  threadId: ThreadId | null;
  onOpenChange: (open: boolean) => void;
}

type AutomationSummary = Awaited<
  ReturnType<ReturnType<typeof ensureNativeApi>["server"]["listAutomations"]>
>["automations"][number];

function formatNextRun(nextRunAt: string | null): string {
  if (!nextRunAt) {
    return "Not scheduled";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(nextRunAt));
}

export function SidebarAutomationsDialog({
  open,
  threadId,
  onOpenChange,
}: SidebarAutomationsDialogProps) {
  const thread = useThreadById(threadId);
  const [automations, setAutomations] = useState<ReadonlyArray<AutomationSummary>>([]);
  const [editingAutomationId, setEditingAutomationId] = useState<AutomationId | null>(null);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [cronExpression, setCronExpression] = useState("0 9 * * 1-5");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editingAutomation = useMemo(
    () => automations.find((automation) => automation.automationId === editingAutomationId) ?? null,
    [automations, editingAutomationId],
  );

  const resetForm = useCallback(() => {
    setEditingAutomationId(null);
    setTitle("");
    setPrompt("");
    setCronExpression("0 9 * * 1-5");
    setError(null);
  }, []);

  const loadAutomations = useCallback(async () => {
    if (!threadId) {
      setAutomations([]);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const api = ensureNativeApi();
      const result = await api.server.listAutomations({ threadId });
      setAutomations(result.automations);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load automations.");
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    if (!open) {
      return;
    }
    void loadAutomations();
  }, [loadAutomations, open]);

  useEffect(() => {
    if (!editingAutomation) {
      return;
    }
    setTitle(editingAutomation.title);
    setPrompt(editingAutomation.prompt);
    setCronExpression(editingAutomation.cronExpression);
    setError(null);
  }, [editingAutomation]);

  const submitLabel = editingAutomation ? "Save automation" : "Create automation";

  const handleSubmit = useCallback(async () => {
    if (!threadId) {
      setError("Open a thread before creating an automation.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const api = ensureNativeApi();
      if (editingAutomation) {
        await api.server.updateAutomation({
          automationId: editingAutomation.automationId,
          title,
          prompt,
          cronExpression,
          timezone: "UTC",
        });
      } else {
        await api.server.createAutomation({
          threadId,
          title,
          prompt,
          cronExpression,
          timezone: "UTC",
        });
      }
      await loadAutomations();
      resetForm();
      toastManager.add({
        type: "success",
        title: editingAutomation ? "Automation updated" : "Automation created",
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save automation.");
    } finally {
      setSaving(false);
    }
  }, [cronExpression, editingAutomation, loadAutomations, prompt, resetForm, threadId, title]);

  const handlePauseResume = useCallback(
    async (automation: AutomationSummary) => {
      try {
        const api = ensureNativeApi();
        if (automation.pausedAt === null) {
          await api.server.pauseAutomation({ automationId: automation.automationId });
        } else {
          await api.server.resumeAutomation({ automationId: automation.automationId });
        }
        await loadAutomations();
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to update automation.");
      }
    },
    [loadAutomations],
  );

  const handleDelete = useCallback(
    async (automation: AutomationSummary) => {
      try {
        const api = ensureNativeApi();
        await api.server.deleteAutomation({ automationId: automation.automationId });
        if (editingAutomationId === automation.automationId) {
          resetForm();
        }
        await loadAutomations();
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to delete automation.");
      }
    },
    [editingAutomationId, loadAutomations, resetForm],
  );

  const handleTrigger = useCallback(async (automation: AutomationSummary) => {
    try {
      const api = ensureNativeApi();
      await api.server.triggerAutomation({ automationId: automation.automationId });
      toastManager.add({
        type: "success",
        title: "Automation triggered",
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to trigger automation.");
    }
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Automations</DialogTitle>
          <DialogDescription>
            {thread
              ? `Manage scheduled prompts for "${thread.title}".`
              : "Open a thread to manage scheduled prompts."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  Schedules run as regular turns in this thread. Cron expressions use UTC.
                </p>
                <Button size="xs" variant="outline" onClick={resetForm}>
                  <PlusIcon />
                  New
                </Button>
              </div>

              <div className="space-y-2">
                {loading ? (
                  <p className="text-sm text-muted-foreground">Loading automations…</p>
                ) : automations.length === 0 ? (
                  <div className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
                    No automations yet for this thread.
                  </div>
                ) : (
                  automations.map((automation) => {
                    const isEditing = automation.automationId === editingAutomationId;
                    return (
                      <button
                        key={automation.automationId}
                        type="button"
                        className={`w-full rounded-xl border px-4 py-3 text-left transition-colors ${
                          isEditing
                            ? "border-primary/40 bg-primary/5"
                            : "border-border/70 hover:bg-accent/40"
                        }`}
                        onClick={() => {
                          setEditingAutomationId(automation.automationId);
                        }}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="truncate text-sm font-medium">{automation.title}</p>
                              <Badge variant="outline" className="text-xs">
                                {automation.pausedAt === null ? "Active" : "Paused"}
                              </Badge>
                            </div>
                            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                              {automation.prompt}
                            </p>
                            <p className="mt-2 text-xs text-muted-foreground">
                              <code>{automation.cronExpression}</code> • next{" "}
                              {formatNextRun(automation.nextRunAt)}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              aria-label="Run automation now"
                              onClick={(event) => {
                                event.stopPropagation();
                                void handleTrigger(automation);
                              }}
                            >
                              <PlayIcon />
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={(event) => {
                                event.stopPropagation();
                                void handlePauseResume(automation);
                              }}
                            >
                              {automation.pausedAt === null ? "Pause" : "Resume"}
                            </Button>
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              aria-label="Delete automation"
                              onClick={(event) => {
                                event.stopPropagation();
                                void handleDelete(automation);
                              }}
                            >
                              <Trash2Icon />
                            </Button>
                          </div>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            <div className="space-y-4 rounded-xl border border-border/70 p-4">
              <div>
                <h3 className="text-sm font-medium">
                  {editingAutomation ? "Edit automation" : "Create automation"}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Use standard 5-field cron syntax, for example <code>0 9 * * 1-5</code>.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="automation-title">Title</Label>
                <Input
                  id="automation-title"
                  autoFocus
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Daily summary"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="automation-cron">Cron</Label>
                <Input
                  id="automation-cron"
                  value={cronExpression}
                  onChange={(event) => setCronExpression(event.target.value)}
                  placeholder="0 9 * * 1-5"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="automation-prompt">Prompt</Label>
                <Textarea
                  id="automation-prompt"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Summarize today’s work and point out follow-up tasks."
                />
              </div>

              {error ? <p className="text-xs text-destructive">{error}</p> : null}
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button type="button" disabled={!threadId || saving} onClick={() => void handleSubmit()}>
            {saving ? "Saving…" : submitLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
