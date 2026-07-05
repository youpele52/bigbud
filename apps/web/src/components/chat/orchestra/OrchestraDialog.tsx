import {
  type ModelSelection,
  type RuntimeMode,
  type ServerDiscoveredSkill,
  type ServerProvider,
} from "@bigbud/contracts";
import { type ComponentProps, useEffect, useRef, useState } from "react";
import { MessageSquareTextIcon, XIcon } from "lucide-react";
import { createModelSelection } from "~/models/provider";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Radio, RadioGroup } from "~/components/ui/radio-group";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { ProviderModelPicker } from "../provider/ProviderModelPicker";

import {
  createOrchestraOperations,
  runOrchestra,
  type OrchestraAssignmentDraft,
  type OrchestraRunMode,
} from "./orchestra.runner";
import {
  ORCHESTRA_SCORE_NAME_MAX_LENGTH,
  resolveOrchestraScoreName,
  validateOrchestraScoreName,
} from "./orchestra.naming";
import type { Project, Thread } from "../../../models/types";

type ModelOptionsByProvider = ComponentProps<typeof ProviderModelPicker>["modelOptionsByProvider"];

function createAssignment(modelSelection: ModelSelection, prompt = ""): OrchestraAssignmentDraft {
  return {
    id: crypto.randomUUID(),
    modelSelection,
    prompt,
  };
}

function buildDefaultAssignments(
  modelSelection: ModelSelection,
  prompt: string,
): OrchestraAssignmentDraft[] {
  return [createAssignment(modelSelection, prompt.trim()), createAssignment(modelSelection)];
}

export function OrchestraDialog(props: {
  activeProject: Project | null | undefined;
  activeThread: Thread | null | undefined;
  defaultModelSelection: ModelSelection;
  discoveredSkills: ReadonlyArray<ServerDiscoveredSkill>;
  modelOptionsByProvider: ModelOptionsByProvider;
  open: boolean;
  providers: ReadonlyArray<ServerProvider>;
  prompt: string;
  runtimeMode: RuntimeMode;
  onOpenChange: (open: boolean) => void;
}) {
  const wasOpenRef = useRef(props.open);
  const [mode, setMode] = useState<OrchestraRunMode>("together");
  const [assignments, setAssignments] = useState<OrchestraAssignmentDraft[]>(() =>
    buildDefaultAssignments(props.defaultModelSelection, props.prompt),
  );
  const [scoreName, setScoreName] = useState("");
  const [isStarting, setIsStarting] = useState(false);

  useEffect(() => {
    if (props.open && !wasOpenRef.current) {
      setAssignments(buildDefaultAssignments(props.defaultModelSelection, props.prompt));
      setMode("together");
      setScoreName("");
    }
    wasOpenRef.current = props.open;
  }, [props.defaultModelSelection, props.open, props.prompt]);

  const handoffAvailable = props.discoveredSkills.some((skill) => skill.name === "handoff");
  const scoreNameError = validateOrchestraScoreName(scoreName);
  const canStart =
    !isStarting &&
    !!props.activeProject &&
    !scoreNameError &&
    assignments.length >= 2 &&
    assignments.every((assignment) => assignment.prompt.trim().length > 0) &&
    (mode === "together" || handoffAvailable);

  const updateAssignment = (
    id: string,
    update: Partial<Pick<OrchestraAssignmentDraft, "prompt" | "modelSelection">>,
  ) => {
    setAssignments((existing) =>
      existing.map((assignment) =>
        assignment.id === id ? { ...assignment, ...update } : assignment,
      ),
    );
  };

  const addAssignment = () => {
    setAssignments((existing) => [...existing, createAssignment(props.defaultModelSelection)]);
  };

  const removeAssignment = (id: string) => {
    setAssignments((existing) =>
      existing.length <= 2 ? existing : existing.filter((a) => a.id !== id),
    );
  };

  const onStart = async () => {
    if (!props.activeProject) {
      return;
    }

    const resolvedScoreName = resolveOrchestraScoreName(scoreName);
    setIsStarting(true);
    const orchestrationRun = runOrchestra(
      {
        mode,
        assignments,
        scoreName: resolvedScoreName,
      },
      createOrchestraOperations({
        activeProject: props.activeProject,
        activeThread: props.activeThread ?? null,
        interactionMode: "default",
        runtimeMode: props.runtimeMode,
      }),
    );

    if (mode === "sequence") {
      props.onOpenChange(false);
      setIsStarting(false);
      toastManager.add({
        type: "success",
        title: "Orchestra started",
        description: `Child threads under ${resolvedScoreName} will run one at a time with handoff between them.`,
      });
      void orchestrationRun
        .then(() => {
          toastManager.add({
            type: "success",
            title: "Orchestra finished",
            description: "Sequential child threads completed.",
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Orchestra stopped",
            description:
              error instanceof Error ? error.message : "An error occurred while running Orchestra.",
          });
        });
      return;
    }

    try {
      const result = await orchestrationRun;
      toastManager.add({
        type: "success",
        title: "Orchestra started",
        description:
          result.threadIds.length === 1
            ? `Started 1 child thread under ${result.parentThreadTitle}.`
            : `Started ${result.threadIds.length} child threads under ${result.parentThreadTitle}.`,
      });
      props.onOpenChange(false);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not start Orchestra",
        description:
          error instanceof Error ? error.message : "An error occurred while starting Orchestra.",
      });
    } finally {
      setIsStarting(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="w-[min(92vw,56rem)] max-w-4xl">
        <DialogHeader>
          <DialogTitle>Orchestra</DialogTitle>
          <p className="text-muted-foreground text-sm">
            You&apos;re conducting. Choose the players, write their cues, and decide how the
            ensemble enters.
          </p>
        </DialogHeader>
        <DialogPanel className="space-y-6">
          <section className="w-full space-y-2 md:max-w-[50%]">
            <Label className="text-sm">Score name</Label>
            <Input
              value={scoreName}
              maxLength={ORCHESTRA_SCORE_NAME_MAX_LENGTH}
              aria-invalid={scoreNameError ? true : undefined}
              placeholder="Optional. Leave blank and bigbud will name it for you."
              onChange={(event) => setScoreName(event.currentTarget.value)}
            />
            {scoreNameError ? <p className="text-destructive text-xs">{scoreNameError}</p> : null}
          </section>

          <section className="space-y-3">
            <div className="space-y-1">
              <p className="font-medium text-sm">How the ensemble enters</p>
              {mode === "sequence" && !handoffAvailable ? (
                <p className="text-muted-foreground text-xs">
                  In sequence needs the discovered `handoff` skill before it can start.
                </p>
              ) : null}
            </div>
            <RadioGroup value={mode} onValueChange={(value) => setMode(value as OrchestraRunMode)}>
              <label className="flex items-center gap-3 rounded-lg border border-border/70 px-3 py-3">
                <Radio value="together" />
                <span className="space-y-1">
                  <span className="block font-medium text-sm">Together</span>
                  <span className="block text-muted-foreground text-xs">
                    Like a violinist and bassist hitting the same bar, every child thread starts at
                    once.
                  </span>
                </span>
              </label>
              <label className="flex items-center gap-3 rounded-lg border border-border/70 px-3 py-3">
                <Radio value="sequence" />
                <span className="space-y-1">
                  <span className="block font-medium text-sm">In sequence</span>
                  <span className="block text-muted-foreground text-xs">
                    Pass the melody down the line. The next child thread starts only after the
                    previous one finishes and hands off.
                  </span>
                </span>
              </label>
            </RadioGroup>
          </section>

          <section className="space-y-3">
            <div className="space-y-1">
              <p className="font-medium text-sm">Parts</p>
              <p className="text-muted-foreground text-xs">
                You set the parts. Each player performs in a separate child thread.
              </p>
            </div>
            <div className="space-y-3">
              {assignments.map((assignment, index) => (
                <div
                  key={assignment.id}
                  className="relative grid gap-3 rounded-xl border border-border/70 p-3 md:grid-cols-[15rem_minmax(0,1fr)]"
                >
                  <div className="absolute end-2 top-2">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            aria-label="Remove agent"
                            disabled={assignments.length <= 2}
                          />
                        }
                        onClick={() => removeAssignment(assignment.id)}
                      >
                        <XIcon className="size-4" />
                      </TooltipTrigger>
                      <TooltipPopup side="top">
                        {assignments.length <= 2 ? "Keep at least two agents" : "Kick out"}
                      </TooltipPopup>
                    </Tooltip>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs">Player {index + 1}</Label>
                    <ProviderModelPicker
                      provider={assignment.modelSelection.provider}
                      model={assignment.modelSelection.model}
                      lockedProvider={null}
                      providers={props.providers}
                      modelOptionsByProvider={props.modelOptionsByProvider}
                      triggerVariant="outline"
                      triggerClassName="w-full max-w-none shrink-0 justify-start text-foreground/90 hover:text-foreground"
                      onProviderModelChange={(provider, model, subProviderID) => {
                        const nextSelection = createModelSelection(provider, model);
                        updateAssignment(assignment.id, {
                          modelSelection: subProviderID
                            ? ({ ...nextSelection, subProviderID } as ModelSelection)
                            : nextSelection,
                        });
                      }}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs">Cue</Label>
                    <Textarea
                      value={assignment.prompt}
                      onChange={(event) =>
                        updateAssignment(assignment.id, { prompt: event.currentTarget.value })
                      }
                      placeholder="Write this player's cue"
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-center">
              <Button type="button" variant="outline" size="sm" onClick={addAssignment}>
                Add player
              </Button>
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2 text-muted-foreground">
              <MessageSquareTextIcon className="size-3.5" />
              <span className="font-medium text-sm">Opened from</span>
            </div>
            <p className="line-clamp-2 pl-5.5 text-sm leading-6 text-foreground/90">
              {props.activeThread?.title ?? "New chat in the current workspace"}
            </p>
          </section>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={onStart} disabled={!canStart}>
            {isStarting ? "Playing..." : "Play"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
