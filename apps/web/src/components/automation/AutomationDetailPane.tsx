import { type ThreadId } from "@bigbud/contracts";
import { type ReactNode } from "react";

import { ThreadComposerSurface } from "~/components/chat/view/ThreadComposerSurface";
import { Badge } from "~/components/ui/badge";
import {
  AUTOMATION_SKILL_PROMPT,
  buildAutomationSkillDispatchPrompt,
  formatAutomationDateTime,
  getDeviceTimeZone,
} from "~/lib/automation";
import { readNativeApi } from "~/rpc/nativeApi";

type AutomationDetail = Awaited<
  ReturnType<NonNullable<ReturnType<typeof readNativeApi>>["server"]["getAutomation"]>
>["automation"];
type AutomationRun = Awaited<
  ReturnType<NonNullable<ReturnType<typeof readNativeApi>>["server"]["listAutomationRuns"]>
>["runs"][number];

interface AutomationDetailPaneProps {
  readonly automation: AutomationDetail | null;
  readonly editorThreadId: ThreadId | null;
  readonly loadError: string | null;
  readonly loading: boolean;
  readonly onOptimisticUserMessage: (messageId: string | null) => void;
  readonly projectName: string;
  readonly providerLabel: string;
  readonly modelLabel: string;
  readonly reasoningLabel: string;
  readonly runs: ReadonlyArray<AutomationRun>;
  readonly statusLabel: string;
}

export function AutomationDetailPane({
  automation,
  editorThreadId,
  loadError,
  loading,
  onOptimisticUserMessage,
  projectName,
  providerLabel,
  modelLabel,
  reasoningLabel,
  runs,
  statusLabel,
}: AutomationDetailPaneProps) {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden xl:flex-row">
        <div className="flex min-h-0 min-w-0 flex-[2] flex-col overflow-hidden">
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading automation...</p>
            ) : null}
            {!loading && loadError ? (
              <div className="rounded-xl border border-border/70 bg-card/50 p-5">
                <h1 className="text-lg font-medium">Automation unavailable</h1>
                <p className="mt-2 text-sm text-muted-foreground">{loadError}</p>
              </div>
            ) : null}
            {!loading && automation ? (
              <div className="mx-auto w-full max-w-4xl">
                <h1 className="text-3xl font-semibold tracking-tight">{automation.title}</h1>
                <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-foreground/92">
                  {automation.prompt}
                </p>
                <p className="mt-8 text-sm text-muted-foreground">
                  Ask to change the prompt, schedule, project, or execution model. The task will not
                  run during editing.
                </p>
              </div>
            ) : null}
          </div>

          {!loading && automation && editorThreadId ? (
            <div className="shrink-0 px-3 pt-1.5 pb-1 sm:px-5 sm:pt-2">
              <ThreadComposerSurface
                threadId={editorThreadId}
                seedPrompt={AUTOMATION_SKILL_PROMPT}
                onOptimisticUserMessage={onOptimisticUserMessage}
                transformPromptForSend={(prompt) =>
                  buildAutomationSkillDispatchPrompt({
                    rawPrompt: prompt,
                    defaultProjectName: projectName,
                    deviceTimeZone: getDeviceTimeZone(),
                    existingAutomation: {
                      title: automation.title,
                      prompt: automation.prompt,
                      projectName,
                      scheduleLabel: automation.scheduleLabel,
                      timezone: automation.timezone,
                    },
                  })
                }
              />
              <div aria-hidden="true" className="mx-auto h-7 w-full max-w-[52rem] pb-3" />
            </div>
          ) : null}
        </div>

        {!loading && automation ? (
          <aside className="min-h-0 min-w-0 flex-1 overflow-y-auto border-t border-border/70 px-4 py-6 sm:px-6 xl:border-t-0 xl:border-l">
            <div className="space-y-6">
              <DetailCard title="Status">
                <DetailRow
                  label="Current status"
                  value={<Badge variant="outline">{statusLabel}</Badge>}
                />
                <DetailRow
                  label="Next run"
                  value={formatAutomationDateTime(automation.nextRunAt)}
                />
                <DetailRow
                  label="Last ran"
                  value={formatAutomationDateTime(runs[0]?.finishedAt ?? null)}
                />
              </DetailCard>

              <DetailCard title="Details">
                <DetailRow label="Project" value={projectName} />
                <DetailRow label="Schedule" value={automation.scheduleLabel} />
                <DetailRow label="Timezone" value={automation.timezone} />
                <DetailRow label="Provider" value={providerLabel} />
                <DetailRow label="Model" value={modelLabel} />
                <DetailRow label="Reasoning" value={reasoningLabel} />
              </DetailCard>

              <DetailCard title="Previous runs">
                {runs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No runs yet.</p>
                ) : (
                  <div className="space-y-3">
                    {runs.map((run) => (
                      <div
                        key={run.runId}
                        className="rounded-lg border border-border/60 bg-background/60 px-3 py-2"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="truncate text-sm">{automation.title}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {formatAutomationDateTime(run.finishedAt ?? run.startedAt)}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {run.errorMessage ? `Failed: ${run.errorMessage}` : "Completed"}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </DetailCard>
            </div>
          </aside>
        ) : null}
      </div>
    </section>
  );
}

function DetailCard(input: { readonly children: ReactNode; readonly title: string }) {
  return (
    <section className="rounded-xl border border-border/70 bg-card/35 p-5">
      <h2 className="text-sm font-medium">{input.title}</h2>
      <div className="mt-4 space-y-3">{input.children}</div>
    </section>
  );
}

function DetailRow(input: { readonly label: string; readonly value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-sm text-muted-foreground">{input.label}</span>
      <span className="max-w-[14rem] text-right text-sm">{input.value}</span>
    </div>
  );
}
